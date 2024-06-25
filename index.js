const ScraperClient = require('./client')
const ReadyResource = require('ready-resource')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const Hyperswarm = require('hyperswarm')

class PrometheusDhtBridge extends ReadyResource {
  constructor (dht, server) {
    super()

    this.swarm = new Hyperswarm({ dht })

    this.server = server
    this.server.get(
      '/scrape/:alias/metrics',
      { logLevel: 'info' },
      this._handleGet.bind(this)
    )

    this.aliases = new Map() // alias->scrapeClient
  }

  get dht () {
    return this.swarm.dht
  }

  get publicKey () {
    return this.swarm.keyPair.publicKey
  }

  async _close () {
    await Promise.all([
      [...this.aliases.values()].map(a => a.close())
    ])

    await this.swarm.destroy()
  }

  putAlias (alias, targetPubKey) {
    targetPubKey = idEnc.decode(idEnc.normalize(targetPubKey))
    const current = this.aliases.get(alias)

    if (current) {
      if (b4a.equals(current.key, targetPubKey)) {
        return // Idempotent
      }

      current.close().catch(safetyCatch)
    }

    const scrapeClient = new ScraperClient(this.swarm, targetPubKey)
    this.aliases.set(alias, scrapeClient)
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
}

module.exports = PrometheusDhtBridge
