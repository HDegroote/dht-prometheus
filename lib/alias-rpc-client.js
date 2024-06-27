const ReadyResource = require('ready-resource')
const RPC = require('protomux-rpc')
const { AliasReqEnc, AliasRespEnc } = require('./encodings')
const HyperDHT = require('hyperdht')

const PROTOCOL_NAME = 'register-alias'

class AliasClient extends ReadyResource {
  constructor (ownPublicKey, targetPubKey, secret, { bootstrap }) {
    super()

    // TODO: see if we can't pass in our own DHT, so
    // our public key is implicit in the request and need not be passed
    this.dht = null
    this.bootstrap = bootstrap
    this.targetKey = targetPubKey
    this.secret = secret
    this.ownPublicKey = ownPublicKey
  }

  async registerAlias () {
    this.dht = new HyperDHT({ bootstrap: this.bootstrap })

    const socket = this.dht.connect(this.targetKey)
    await socket.opened

    if (!socket.connected) {
      throw new Error('Could not open socket')
    }

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })
    await rpc.fullyOpened()

    const res = await rpc.request(
      'alias',
      {
        alias: 'dummy',
        targetPublicKey: this.ownPublicKey,
        secret: this.secret
      },
      { requestEncoding: AliasReqEnc, responseEncoding: AliasRespEnc }
    )

    await this.dht.destroy()
    return res
    // console.log('registered', res)
  }
}

module.exports = AliasClient
