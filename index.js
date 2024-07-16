const ReadyResource = require('ready-resource')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const Hyperswarm = require('hyperswarm')
const HyperDht = require('hyperdht')
const AliasRpcServer = require('./lib/alias-rpc')

const ScraperClient = require('dht-prom-client/scraper')
const { writePromTargets, readPromTargets } = require('./lib/prom-targets')
const debounceify = require('debounceify')

const DEFAULT_PROM_TARGETS_LOC = './targets.json'

class PrometheusDhtBridge extends ReadyResource {
  constructor (dht, server, sharedSecret, {
    _forceFlushOnClientReady = false,
    prometheusTargetsLoc = DEFAULT_PROM_TARGETS_LOC
  } = {}) {
    super()

    const keyPair = HyperDht.keyPair()
    this.swarm = new Hyperswarm({
      dht,
      keyPair
    })

    this.secret = sharedSecret // Shared with clients

    this.server = server
    this.server.get(
      '/scrape/:alias/metrics',
      { logLevel: 'info' },
      this._handleGet.bind(this)
    )

    this.promTargetsLoc = prometheusTargetsLoc
    this.aliasRpcServer = new AliasRpcServer(this.swarm, this.secret, this.putAlias.bind(this))

    this.aliases = new Map()
    this._writeAliases = debounceify(this._writeAliasesUndebounced.bind(this))

    // for tests, to ensure we're connected to the scraper on first scrape
    this._forceFlushOnCLientReady = _forceFlushOnClientReady
  }

  get dht () {
    return this.swarm.dht
  }

  get publicKey () {
    return this.swarm.keyPair.publicKey
  }

  async _open () {
    await this._loadAliases()

    // It is important that the aliases are first loaded
    // otherwise the old aliases might get overwritten
    await this.aliasRpcServer.ready()
  }

  async _close () {
    await this.aliasRpcServer.close()

    await Promise.all([
      [...this.aliases.values()].map(a => a.close())
    ])

    await this.swarm.destroy()
    if (this.opened) await this._writeAliases()
  }

  putAlias (alias, targetPubKey, { write = true } = {}) {
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

    if (write === true) {
      this._writeAliases().catch(safetyCatch)
    }

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

    if (!scrapeClient.opened) {
      await scrapeClient.ready()
      if (this._forceFlushOnCLientReady) await scrapeClient.swarm.flush()
    }

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

  async _writeAliasesUndebounced () { // should never throw
    try {
      await writePromTargets(this.promTargetsLoc, this.aliases)
      this.emit('aliases-updated', this.promTargetsLoc)
    } catch (e) {
      this.emit('write-aliases-error', e)
    }
  }

  async _loadAliases () { // should never throw
    try {
      const aliases = await readPromTargets(this.promTargetsLoc)
      for (const [alias, pubKey] of aliases) {
        // Write false since we load an existing state
        // (otherwise we overwrite them 1 by 1, and can lose
        // entries if we restart/crash during setup)
        this.putAlias(alias, pubKey, { write: false })
      }
    } catch (e) {
      this.emit('load-aliases-error', e)
    }
  }
}

module.exports = PrometheusDhtBridge
