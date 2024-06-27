const ScraperClient = require('./client')
const ReadyResource = require('ready-resource')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const Hyperswarm = require('hyperswarm')
const HyperDht = require('hyperdht')
const AliasRpcServer = require('./lib/alias-rpc')

class PrometheusDhtBridge extends ReadyResource {
  constructor (dht, server, sharedSecret) {
    super()

    const keyPair = HyperDht.keyPair()
    this.swarm = new Hyperswarm({
      dht,
      keyPair
      // firewall: this._firewall.bind(this)
    })

    this.secret = sharedSecret // Shared with clients

    this.server = server
    this.server.get(
      '/scrape/:alias/metrics',
      { logLevel: 'info' },
      this._handleGet.bind(this)
    )

    this.aliasRpcServer = new AliasRpcServer(this.swarm, this.secret, this.putAlias.bind(this))

    this.aliases = new Map() // alias->scrapeClient
  }

  get dht () {
    return this.swarm.dht
  }

  get publicKey () {
    return this.swarm.keyPair.publicKey
  }

  async _open () {
    await this.aliasRpcServer.ready()
  }

  async _close () {
    await this.aliasRpcServer.close()

    await Promise.all([
      [...this.aliases.values()].map(a => a.close())
    ])

    await this.swarm.destroy()
  }

  putAlias (alias, targetPubKey) {
    targetPubKey = idEnc.decode(idEnc.normalize(targetPubKey))
    const current = this.aliases.get(alias)

    if (current) {
      if (b4a.equals(current.targetKey, targetPubKey)) {
        const updated = false // Idempotent
        return updated
      }

      current.close().catch(safetyCatch)
    }

    const scrapeClient = new ScraperClient(this.swarm, targetPubKey)
    this.aliases.set(alias, scrapeClient)

    const updated = true
    return updated
  }

  async _handleGet (req, reply) {
    const alias = req.params.alias

    const scrapeClient = this.aliases.get(alias)

    if (!scrapeClient) {
      reply.code(404)
      reply.send('Unknown alias')
      return
    }

    if (!scrapeClient.opened) await scrapeClient.ready()

    let res
    try {
      res = await scrapeClient.lookup()
    } catch (e) {
      console.error(e)
      this.emit('upstream-error', e)
      reply.code(502)
      reply.send('Upstream unavailable')
    }

    if (res.success) {
      reply.send(res.metrics)
    } else {
      reply.code(502)
      reply.send(`Upstream error: ${res.errorMessage}`)
    }
  }

  /* _firewall (remotePublicKey, payload, address) {
    console.log('fire?')
    const knowsPrivateKey = b4a.equals(
      remotePublicKey,
      this.swarm.keyPair.publicKey
    )

    if (!knowsPrivateKey) {
      console.log('blocking it', remotePublicKey, 'me', this.swarm.keyPair.publicKey)
      this.emit('firewall-block', { remotePublicKey, payload, address })
    }

    return !knowsPrivateKey
  } */
}

module.exports = PrometheusDhtBridge
