const crypto = require('crypto')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const RPC = require('protomux-rpc')
const { MetricsReplyEnc } = require('dht-prom-client/lib/encodings')
const b4a = require('b4a')

const PROTOCOL_NAME = 'prometheus-metrics'

/*
Assuming Hyperswarm makes sense, what do you tink of the following pattern for a Client?
I think this would also handle reconnects out of the box, and it seems easier
Note: it uses a passed-in hyperswarm instead of creating a new one, because that way it scales to many ClientRequest without polluting the DHT with identities, but this does add some complexity

class Client extends ReadyResource {
  constructor (swarm, targetKey) {
    super()

    this.swarm = swarm
    this.targetKey = targetKey

    this.rpc = null
    this.socket = null
    this._currentConnUid = null

    this._swarmHandler = this.swarm.on('connection', (socket, peerInfo) => {
      if (!b4a.equals(peerInfo.publicKey, this.targetKey)) {
        // Not our connection
        return
      }

      const connUid = crypto.randomUUID() // TODO: check if actually needed
      this._currentConnUid = connUid

      const rpc = new RPC(socket, { protocol: 'my-protocol' })

      socket.on('error', safetyCatch)
      socket.on('close', () => {
        if (connUid === this._currentConnUid) {
          // No other connection arrived in the the mean time
          this.socket = null
          this.rpc = null
          this._currentConnUid = null
        }

        rpc.destroy()
      })

      this.socket = socket
      this.rpc = rpc
    })

    // Handles reconnects/suspends
    this.swarm.joinPeer(this.key)
  }

  _close () {
    this.swarm.off('connection', this._swarmHandler)
    this.swarm.leavePeer(this.targetKey)

    if (this.rpc) this.rpc.destroy()
    if (this.socket) this.socket.destroy()
  }

  async makeRpcRequest () {
    if (!this.rpc) throw new Error('Not connected')

    if (this.rpc && !this.rpc.opened) await this.rpc._channel.fullyOpened()

    // Send the request
  }
} */

class ScraperClient extends ReadyResource {
  constructor (swarm, promClientPubKey) {
    super()

    this.swarm = swarm
    this.targetKey = promClientPubKey

    this.rpc = null
    this.socket = null
    this._currentConnUid = null

    this._boundConnectionHandler = this._connectionHandler.bind(this)
    this.swarm.on('connection', this._boundConnectionHandler)

    // Handles reconnects/suspends
    this.swarm.joinPeer(this.targetKey)
  }

  _open () { }

  _close () {
    this.swarm.off('connection', this._boundConnectionHandler)
    this.swarm.leavePeer(this.targetKey)

    if (this.rpc) this.rpc.destroy()
    if (this.socket) this.socket.destroy()
  }

  _connectionHandler (socket, peerInfo) {
    if (!b4a.equals(peerInfo.publicKey, this.targetKey)) {
      // Not our connection
      return
    }

    const connUid = crypto.randomUUID() // TODO: check if actually needed
    this._currentConnUid = connUid

    const rpc = new RPC(socket, { protocol: PROTOCOL_NAME })

    socket.on('error', safetyCatch)
    socket.on('close', () => {
      if (connUid === this._currentConnUid) {
        // No other connection arrived in the the mean time
        this.socket = null
        this.rpc = null
        this._currentConnUid = null
      }

      rpc.destroy()
    })

    this.socket = socket
    this.rpc = rpc
  }

  async lookup () {
    if (!this.rpc) throw new Error('Not connected')

    if (this.rpc && !this.rpc.opened) await this.rpc.fullyOpened()

    // Note: can throw (for example if rpc closed in the mean time)
    const res = await this.rpc.request(
      'metrics',
      null,
      { responseEncoding: MetricsReplyEnc }
    )

    return res
  }
}

module.exports = ScraperClient
