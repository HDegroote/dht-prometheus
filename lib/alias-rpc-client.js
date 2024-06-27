const ReadyResource = require('ready-resource')
const RPC = require('protomux-rpc')
const { AliasReqEnc, AliasRespEnc } = require('./encodings')
const HyperDHT = require('hyperdht')

const PROTOCOL_NAME = 'register-alias'

class AliasClient extends ReadyResource {
  constructor (dht, targetPubKey, secret, { bootstrap }) {
    super()

    const ownPublicKey = dht.defaultKeyPair.publicKey
    // TODO: investigate why we can't use our own DHT
    // (Doig so means the lookup connection is never opened)
    this.dht = null // new HyperDHT({ bootstrap })
    this.bootstrap = bootstrap
    this.targetKey = targetPubKey
    this.secret = secret
    this.ownPublicKey = ownPublicKey
  }

  async registerAlias () {
    this.dht = new HyperDHT({ bootstrap: this.bootstrap })

    const socket = this.dht.connect(this.targetKey, { reusableSocket: true })
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

    rpc.destroy()
    await this.dht.destroy()
    return res
  }
}

module.exports = AliasClient
