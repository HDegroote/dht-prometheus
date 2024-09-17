#! /usr/bin/env node

const HyperDHT = require('hyperdht')
const PrometheusDhtBridge = require('./index')
const pino = require('pino')
const fastify = require('fastify')
const idEnc = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')
const promClient = require('prom-client')

function loadConfig () {
  const config = {
    prometheusTargetsLoc: process.env.DHT_PROM_PROMETHEUS_TARGETS_LOC || './prometheus/targets.json',
    logLevel: (process.env.DHT_PROM_LOG_LEVEL || 'info').toLowerCase(),
    httpPort: process.env.DHT_PROM_HTTP_PORT || 0,
    httpHost: process.env.DHT_PROM_HTTP_HOST || '127.0.0.1',
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

  promClient.collectDefaultMetrics()

  const logger = pino({ level: logLevel })
  logger.info('Starting up Prometheus DHT bridge')

  const dht = new HyperDHT({ bootstrap })
  const server = fastify({ logger })
  const bridge = new PrometheusDhtBridge(dht, server, sharedSecret, {
    keyPairSeed,
    ownPromClient: promClient,
    prometheusTargetsLoc,
    _forceFlushOnClientReady,
    serverLogLevel
  })

  bridge.registerLogger(logger)

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

main()
