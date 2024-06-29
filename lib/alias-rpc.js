const ReadyResource = require('ready-resource')
const RPC = require('protomux-rpc')
const crypto = require('crypto')
const b4a = require('b4a')

// TODO: cleaner dep management (don't want to store the encodings
// twice, but there's a ciruclar dep of sorts)
const { AliasReqEnc, AliasRespEnc } = require('dht-prom-client/lib/encodings')

const PROTOCOL_NAME = 'register-alias'

class AliasRpcServer extends ReadyResource {
  constructor (swarm, secret, putAliasCb) {
    super()

    this.swarm = swarm
    this._putAlias = putAliasCb
    this.secret = secret

    this.swarm.on('connection', this._onconnection.bind(this))
  }

  get publicKey () {
    return this.swarm.keyPair.pubicKey
  }

  async _open () {
    await this.swarm.listen()
  }

  async _close () {
    await this.swarm.destroy()
  }

  _onconnection (socket) {
    const uid = crypto.randomUUID()
    const remotePublicKey = socket.remotePublicKey

    socket.on('error', (error) => {
      this.emit('socket-error', { error, uid, remotePublicKey })
    })

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    rpc.respond(
      'alias',
      { responseEncoding: AliasRespEnc, requestEncoding: AliasReqEnc },
      async (req) => {
        if (!b4a.equals(req.secret, this.secret)) {
          return { success: false, errorMessage: 'unauthorised' }
        }

        const targetPublicKey = req.targetPublicKey
        const alias = req.alias

        this.emit('alias-request', { uid, remotePublicKey, targetPublicKey, alias })
        try {
          const updated = await this._putAlias(alias, targetPublicKey)
          this.emit('register-success', { uid, alias, targetPublicKey, updated })
          return {
            success: true,
            updated
          }
        } catch (error) {
          this.emit('register-error', { error, uid })
          return {
            success: false,
            errorMessage: `Failed to register alias (uid ${uid})`
          }
        }
      }
    )
  }
}

module.exports = AliasRpcServer
