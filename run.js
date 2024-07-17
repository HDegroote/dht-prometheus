const HyperDHT = require('hyperdht')
const PrometheusDhtBridge = require('./index')
const pino = require('pino')
const fastify = require('fastify')
const idEnc = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')

function loadConfig () {
  const config = {
    prometheusTargetsLoc: process.env.DHT_PROM_PROMETHEUS_TARGETS_LOC || './prometheus/targets.json',
    logLevel: process.env.DHT_PROM_LOG_LEVEL || 'info',
    httpPort: process.env.DHT_PROM_HTTP_PORT || 0,
    httpHost: '127.0.0.1',
    _forceFlushOnClientReady: process.env._DHT_PROM_FORCE_FLUSH || 'false' // Tests only
  }

  try {
    config.sharedSecret = idEnc.decode(idEnc.normalize(process.env.DHT_PROM_SHARED_SECRET))
  } catch (e) {
    console.error('DHT_PROM_SHARED_SECRET env var must be set to a valid hypercore key')
    process.exit(1)
  }

  try {
    config.keyPairSeed = idEnc.decode(idEnc.normalize(process.env.DHT_PROM_KEY_PAIR_SEED))
  } catch (e) {
    console.error('DHT_PROM_KEY_PAIR_SEED env var, if set, must be set to a valid hypercore key')
    process.exit(1)
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
    _forceFlushOnClientReady
  } = loadConfig()

  const logger = pino({ level: logLevel })
  logger.info('Starting up Prometheus DHT bridge')

  console.log('TARGETS', prometheusTargetsLoc)
  const dht = new HyperDHT({ bootstrap })
  const server = fastify({ logger })
  const bridge = new PrometheusDhtBridge(dht, server, sharedSecret, {
    keyPairSeed,
    prometheusTargetsLoc,
    _forceFlushOnClientReady
  })

  setupLogging(bridge, logger)

  goodbye(async () => {
    logger.info('Shutting down')
    await server.close()
    logger.info('Http server shut down--now closing the bridge')
    if (bridge.opened) await bridge.close()
    logger.info('Fully shut down')
  })

  server.listen({ address: httpHost, port: httpPort })
  await bridge.ready()
  logger.info(`DHT RPC ready at public key ${idEnc.normalize(bridge.publicKey)}`)
}

function setupLogging (bridge, logger) {
  bridge.on('set-alias', ({ alias, publicKey }) => {
    logger.info(`Registered alias: ${alias} -> ${idEnc.normalize(publicKey)}`)
  })

  bridge.on('aliases-updated', (loc) => {
    logger.info(`Updated the aliases file at ${loc}`)
  })

  bridge.on('load-aliases-error', e => { // TODO: test
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

  bridge.aliasRpcServer.on(
    'register-error', ({ uid, error }) => {
      logger.info(`Alias error: ${error} (${uid})`)
    }
  )
}

main()
