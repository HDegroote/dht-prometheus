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
    httpHost: '127.0.0.1'
  }

  try {
    config.sharedSecret = idEnc.normalize(process.env.DHT_PROM_SHARED_SECRET)
  } catch (e) {
    console.error('DHT_PROM_SHARED_SECRET env var must be set to a valid hypercore key')
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
    httpHost
  } = loadConfig()

  const logger = pino({ level: logLevel })
  logger.info('Starting up Prometheus DHT bridge')

  const dht = new HyperDHT({ bootstrap })
  const server = fastify({ logger })
  const bridge = new PrometheusDhtBridge(dht, server, sharedSecret, {
    prometheusTargetsLoc
  })

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

main()
