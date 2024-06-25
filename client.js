const { once } = require('events')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const RPC = require('protomux-rpc')
const { MetricsReplyEnc } = require('dht-prom-client/lib/encodings')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')

class ScraperClient extends ReadyResource {
  constructor (swarm, promClientPublicKey) {
    super()

    this.swarm = swarm
    this.key = idEnc.decode(idEnc.normalize(promClientPublicKey))

    this.rpc = null
    this.socket = null
    this.swarm.on('connection', (socket, peerInfo) => {
      if (!b4a.equals(peerInfo.publicKey, this.key)) return // Not our connection

      this.emit('connection', peerInfo)
      this.socket = socket

      this.socket.on('error', safetyCatch)
      this.socket.on('close', () => {
        this.socket = null
        this.rpc = null
      })

      this.rpc = new RPC(this.socket, { protocol: 'prometheus-metrics' })
      this.rpcReady = once(this.rpc, 'open')
      this.rpcReady.catch(e => console.error(e))

      console.log('connection set')
    })

    this.swarm.joinPeer(this.key)
  }

  _open () { }

  async _close () {
    this.rpc?.destroy()
    this.socket?.destroy()
  }

  async lookup () {
    // console.log('lookup', this.rpc)
    if (!this.rpc) throw new Error('Not connected')

    await this.rpcReady

    const res = await this.rpc.request(
      'metrics',
      null,
      { responseEncoding: MetricsReplyEnc }
    )

    return res
  }
}

module.exports = ScraperClient
