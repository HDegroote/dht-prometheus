const { once } = require('events')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const RPC = require('protomux-rpc')
const { MetricsReplyEnc } = require('dht-prom-client/lib/encodings')

class ScraperClient extends ReadyResource {
  constructor (dht, promClientPublicKey) {
    super()

    this.dht = dht
    this.key = promClientPublicKey
    this.rpc = null
    this.socket = null
  }

  async _open () {
    // TODO: auto reconnect
    // TODO: retry on failure
    // TODO: define a keepAlive
    // TODO: handle error paths (peer not available etc)
    this.socket = this.dht.connect(this.key)
    this.socket.on('error', safetyCatch)

    await this.socket.opened

    if (!this.socket.connected) {
      throw new Error('Could not open socket')
    }

    this.rpc = new RPC(this.socket, { protocol: 'prometheus-metrics' })
    await once(this.rpc, 'open')
  }

  async _close () {
    this.rpc?.destroy()
    this.socket?.destroy()
  }

  async lookup () {
    if (!this.opened) await this.ready()

    const res = await this.rpc.request(
      'metrics',
      null,
      { responseEncoding: MetricsReplyEnc }
    )

    return res
  }
}

module.exports = ScraperClient
