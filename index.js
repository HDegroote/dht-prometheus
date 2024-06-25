const ScraperClient = require('./client')
const ReadyResource = require('ready-resource')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')

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

  async _close () {
    await Promise.all([
      [...this.aliases.values()].map(a => a.close())
    ])
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
