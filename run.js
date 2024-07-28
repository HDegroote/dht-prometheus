#! /usr/bin/env node

const HyperDHT = require('hyperdht')
const PrometheusDhtBridge = require('./index')
const pino = require('pino')
const fastify = require('fastify')
const idEnc = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')

function loadConfig () {
  const config = {
    prometheusTargetsLoc: process.env.DHT_PROM_PROMETHEUS_TARGETS_LOC || './prometheus/targets.json',
    logLevel: (process.env.DHT_PROM_LOG_LEVEL || 'info').toLowerCase(),
    httpPort: process.env.DHT_PROM_HTTP_PORT || 0,
    httpHost: '127.0.0.1',
    _forceFlushOnClientReady: process.env._DHT_PROM_FORCE_FLUSH || 'false' // Tests only
  }

  config.serverLogLevel = config.logLevel === 'debug'
    ? 'info'
    : 'warn' // No need to log all metrics requests

  try {
    config.sharedSecret = idEnc.decode(idEnc.normalize(process.env.DHT_PROM_SHARED_SECRET))
  } catch (e) {
    console.error('DHT_PROM_SHARED_SECRET env var must be set to a valid hypercore key')
    process.exit(1)
  }

  try {
    config.keyPairSeed = idEnc.decode(idEnc.normalize(process.env.DHT_PROM_KEY_PAIR_SEED))
  } catch (e) {
    if (process.env.DHT_PROM_KEY_PAIR_SEED) {
      console.error('DHT_PROM_KEY_PAIR_SEED env var, if set, must be set to a valid hypercore key')
      process.exit(1)
    }
  }

  if (process.env.DHT_PROM_BOOTSTRAP_PORT) { // For tests
    config.bootstrap = [{
      port: parseInt(process.env.DHT_PROM_BOOTSTRAP_PORT),
      host: '127.0.0.1'
    }]
  }

  return config
}

async function main () {
  const {
    bootstrap,
    logLevel,
    prometheusTargetsLoc,
    sharedSecret,
    httpPort,
    httpHost,
    keyPairSeed,
    serverLogLevel,
    _forceFlushOnClientReady
  } = loadConfig()

  const logger = pino({ level: logLevel })
  logger.info('Starting up Prometheus DHT bridge')

  const dht = new HyperDHT({ bootstrap })
  const server = fastify({ logger })
  const bridge = new PrometheusDhtBridge(dht, server, sharedSecret, {
    keyPairSeed,
    prometheusTargetsLoc,
    _forceFlushOnClientReady,
    serverLogLevel
  })

  setupLogging(bridge, logger)

  goodbye(async () => {
    logger.info('Shutting down')
    await server.close()
    logger.info('Http server shut down--now closing the bridge')
    if (bridge.opened) await bridge.close()
    logger.info('Fully shut down')
  })

  server.listen({ host: httpHost, port: httpPort })
  await bridge.ready()
  logger.info(`DHT RPC ready at public key ${idEnc.normalize(bridge.publicKey)}`)
}

function setupLogging (bridge, logger) {
  bridge.on('set-alias', ({ alias, entry }) => {
    const scrapeClient = entry.scrapeClient
    const publicKey = scrapeClient.targetKey
    const { service, hostname } = entry

    logger.info(`Registered alias: ${alias} -> ${idEnc.normalize(publicKey)} (${service} on host ${hostname})`)

    scrapeClient.on('connection-open', ({ uid, targetKey, peerInfo }) => {
      logger.info(`Scraper for ${alias}->${idEnc.normalize(targetKey)} opened connection from ${idEnc.normalize(peerInfo.publicKey)} (uid: ${uid})`)
    })
    scrapeClient.on('connection-close', ({ uid }) => {
      logger.info(`Scraper for ${alias} closed connection (uid: ${uid})`)
    })
    scrapeClient.on('connection-error', ({ error, uid }) => {
      logger.info(`Scraper for ${alias} connection error (uid: ${uid})`)
      logger.info(error)
    })

    if (logger.level === 'debug') {
      scrapeClient.on('connection-ignore', ({ uid }) => {
        logger.debug(`Scraper for ${alias} ignored connection (uid: ${uid})`)
      })
    }
  })

  bridge.on('aliases-updated', (loc) => {
    logger.info(`Updated the aliases file at ${loc}`)
  })

  bridge.on('alias-expired', ({ alias, publicKey }) => {
    logger.info(`Alias entry expired: ${alias} -> ${idEnc.normalize(publicKey)}`)
  })

  bridge.on('load-aliases-error', e => { // TODO: test
    // Expected first time the service starts (creates it then)
    logger.error('failed to load aliases file')
    logger.error(e)
  })

  bridge.on('upstream-error', e => { // TODO: test
    logger.info('upstream error:')
    logger.info(e)
  })

  bridge.on('write-aliases-error', e => {
    logger.error('Failed to write aliases file')
    logger.error(e)
  })

  bridge.aliasRpcServer.on(
    'alias-request',
    ({ uid, remotePublicKey, targetPublicKey, alias }) => {
      logger.info(`Alias request from ${idEnc.normalize(remotePublicKey)} to set ${alias}->${idEnc.normalize(targetPublicKey)} (uid ${uid})`)
    }
  )
  bridge.aliasRpcServer.on(
    'register-success', ({ uid, alias, targetPublicKey, updated }) => {
      logger.info(`Alias success for ${alias}->${idEnc.normalize(targetPublicKey)}--updated: ${updated} (uid: ${uid})`)
    }
  )
  // TODO: log IP address + rate limit
  bridge.aliasRpcServer.on(
    'alias-unauthorised', ({ uid, remotePublicKey, targetPublicKey, alias }) => {
      logger.info(`Unauthorised alias request from ${idEnc.normalize(remotePublicKey)} to set alias ${alias}->${idEnc.normalize(targetPublicKey)} (uid: ${uid})`)
    }
  )
  bridge.aliasRpcServer.on(
    'register-error', ({ uid, error }) => {
      logger.info(`Alias error: ${error} (${uid})`)
    }
  )

  bridge.aliasRpcServer.on(
    'connection-open',
    ({ uid, peerInfo }) => {
      const remotePublicKey = idEnc.normalize(peerInfo.publicKey)
      logger.info(`Alias server opened connection to ${idEnc.normalize(remotePublicKey)} (uid ${uid})`)
    }
  )
  bridge.aliasRpcServer.on(
    'connection-close',
    ({ uid, peerInfo }) => {
      const remotePublicKey = idEnc.normalize(peerInfo.publicKey)
      logger.info(`Alias server closed connection to ${idEnc.normalize(remotePublicKey)} (uid ${uid})`)
    }
  )
  bridge.aliasRpcServer.on(
    'connection-error',
    ({ uid, error, peerInfo }) => {
      const remotePublicKey = idEnc.normalize(peerInfo.publicKey)
      logger.info(`Alias server socket error: ${error.stack} on connection to ${idEnc.normalize(remotePublicKey)} (uid ${uid})`)
    }
  )
}

main()
