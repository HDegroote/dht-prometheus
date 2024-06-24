const ScraperClient = require('./client')
const ReadyResource = require('ready-resource')

class PrometheusDhtBridge extends ReadyResource {
  constructor (dht, server) {
    super()

    this.dht = dht

    this.server = server
    this.server.get(
      '/scrape/:alias/metrics',
      { logLevel: 'info' },
      this._handleGet.bind(this)
    )

    this.aliases = new Map() // alias->scrapeClient
  }

  get publicKey () {
    return this.dht.defaultKeyPair.publicKey
  }

  putAlias (alias, targetPubKey) {
    // TODO: only reset if new or not the same key
    const scrapeClient = new ScraperClient(this.dht, targetPubKey)
    this.aliases.set(alias, scrapeClient)
  }

  async _handleGet (req, reply) {
    const alias = req.params.alias

    const scrapeClient = this.aliases.get(alias)

    if (!scrapeClient) {
      // TODO: 404 code
      throw new Error('Unkown alias')
    }

    if (!scrapeClient.opened) await scrapeClient.ready()

    const res = await scrapeClient.lookup()
    if (res.success) {
      reply.send(res.metrics)
    } else {
      // TODO:
    }
  }
}

module.exports = PrometheusDhtBridge
