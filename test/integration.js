const fs = require('fs')
const process = require('process')
const { spawn } = require('child_process')
const NewlineDecoder = require('newline-decoder')
const path = require('path')
const getTmpDir = require('test-tmp')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const hypCrypto = require('hypercore-crypto')
const idEnc = require('hypercore-id-encoding')
const promClient = require('prom-client')
const DhtPromClient = require('dht-prom-client')
const HyperDHT = require('hyperdht')
const z32 = require('z32')
const axios = require('axios')

const BRIDGE_EXECUTABLE = path.join(path.dirname(__dirname), 'run.js')
const PROMETHEUS_EXECUTABLE = path.join(path.dirname(__dirname), 'prometheus', 'prometheus')

const DEBUG = true
const DEBUG_PROMETHEUS = false

// To force the process.on('exit') to be called on those exits too
process.prependListener('SIGINT', () => process.exit(1))
process.prependListener('SIGTERM', () => process.exit(1))

test('Integration test, happy path', async t => {
  t.timeout(120_000) // ~20s expected

  if (!fs.existsSync(PROMETHEUS_EXECUTABLE)) {
    throw new Error('the integration test requires a prometheus exec')
  }

  promClient.collectDefaultMetrics() // So we have something to scrape
  t.teardown(() => {
    promClient.register.clear()
  })

  const tBridgeSetup = t.test('Bridge setup')
  tBridgeSetup.plan(2)

  const tBridgeShutdown = t.test('Bridge shut down')
  tBridgeShutdown.plan(2)

  const tAliasReq = t.test('Alias request from new service')
  tAliasReq.plan(2)

  const tPromReady = t.test('Prometheus setup')
  tPromReady.plan(1)

  const tGotScraped = t.test('Client scraped through the bridge')
  tGotScraped.plan(2)

  const tPromFailedToScrape = t.test('Bridge went offline')
  tPromFailedToScrape.plan(1)

  const tGotScrapedPostRe = t.test('Client scraped through the bridge (post restart)')
  tGotScrapedPostRe.plan(2)

  const tAlias2Req = t.test('Alias request from the second service')
  tAlias2Req.plan(2)

  const tClient2GotScraped = t.test('Client 2 scraped through the bridge')
  tClient2GotScraped.plan(2)

  const tRestartedBridgeShutdown = t.test('Shutdown restarted bridge')
  tRestartedBridgeShutdown.plan(1)

  const testnet = await createTestnet()
  t.teardown(async () => await testnet.destroy(), 1000)

  const tmpDir = await getTmpDir()
  const promTargetsLoc = path.join(tmpDir, 'targets.json')
  const sharedSecret = hypCrypto.randomBytes(32)
  const z32SharedSecret = idEnc.normalize(sharedSecret)

  // 1) Setup the bridge
  const bridgeEnvVars = {
    DHT_PROM_PROMETHEUS_TARGETS_LOC: promTargetsLoc,
    DHT_PROM_SHARED_SECRET: z32SharedSecret,
    DHT_PROM_KEY_PAIR_SEED: idEnc.normalize(hypCrypto.randomBytes(32)),
    DHT_PROM_BOOTSTRAP_PORT: testnet.bootstrap[0].port,
    _DHT_PROM_FORCE_FLUSH: true,
    DHT_PROM_LOG_LEVEL: 'debug'
  }

  const firstBridgeProc = spawn(
    process.execPath,
    [BRIDGE_EXECUTABLE],
    {
      env: bridgeEnvVars
    }
  )

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    // TODO: unset this handler on clean run
    firstBridgeProc.kill('SIGKILL')
  })

  firstBridgeProc.stderr.on('data', d => {
    console.error(d.toString())
    t.fail('There should be no stderr')
  })

  let bridgeHttpAddress = null
  let bridgeHttpPort = null
  let scraperPubKey = null

  let gotScrapedOnce = false
  let gotScrapedOnceSuccessfully = false
  {
    const stdoutDec = new NewlineDecoder('utf-8')
    firstBridgeProc.stdout.on('data', async d => {
      if (DEBUG) console.log(d.toString())

      for (const line of stdoutDec.push(d)) {
        if (line.includes('Server listening at')) {
          bridgeHttpAddress = line.match(/http:\/\/127.0.0.1:[0-9]{3,5}/)[0]
          bridgeHttpPort = bridgeHttpAddress.split(':')[2]
          tBridgeSetup.pass('http server running')
        }

        if (line.includes('DHT RPC ready at')) {
          const pubKeyRegex = new RegExp(`[${z32.ALPHABET}]{52}`)
          scraperPubKey = line.match(pubKeyRegex)[0]
          tBridgeSetup.pass('dht rpc service running')
        }

        if (line.includes('Alias request from')) {
          tAliasReq.pass('Received alias request')
        }

        if (line.includes('Alias success')) {
          tAliasReq.pass('Successfully processed alias request')
        }

        if (!gotScrapedOnce && line.includes('"url":"/scrape/dummy/metrics"')) {
          tGotScraped.pass('Scrape request received from prometheus')
          gotScrapedOnce = true
        }

        if (!gotScrapedOnceSuccessfully && line.includes('"statusCode":200')) {
          tGotScraped.pass('Scraped successfully')
          gotScrapedOnceSuccessfully = true
        }

        if (line.includes('Fully shut down')) {
          tBridgeShutdown.pass('Shut down cleanly')
        }
      }
    })
  }

  await tBridgeSetup

  // 2) Setting up a client
  {
    const client = getClient(t, testnet.bootstrap, scraperPubKey, sharedSecret)
    client.on('register-alias-error', e => {
      console.error(e)
      t.fail('Error when client tried to register alias')
    })
    await client.ready()
  }

  await tAliasReq

  const res = await axios.get(`${bridgeHttpAddress}/metrics`)
  t.is(res.status, 200, 'can scrape own metrics')
  t.is(res.data.includes('nodejs_eventloop_lag_mean_seconds'), true, 'sanity check')

  // 3) Setup prometheus
  const promConfigFileLoc = path.join(tmpDir, 'prometheus.yml')
  await writePromConfig(promConfigFileLoc, bridgeHttpAddress, promTargetsLoc)

  const promProc = spawn(
    PROMETHEUS_EXECUTABLE,
    [`--config.file=${promConfigFileLoc}`, '--log.level=debug']
  )

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    // TODO: unset this handler on clean run
    promProc.kill('SIGKILL')
  })

  {
    const stdoutDec = new NewlineDecoder('utf-8')
    // Prometheus logs everything to stderr, so we listen to that
    let confirmedBridgeOffline = false

    promProc.stderr.on('data', d => {
      if (DEBUG_PROMETHEUS) console.log('PROMETHEUS', d.toString())

      for (const line of stdoutDec.push(d)) {
        if (line.includes('Server is ready to receive web requests')) {
          tPromReady.pass('Prometheus ready')
        }

        if (gotScrapedOnceSuccessfully && !confirmedBridgeOffline && line.includes('msg="Scrape failed"')) {
          // Note: could in theory also fail for other reasons
          tPromFailedToScrape.pass('The bridge is no longer available')
          confirmedBridgeOffline = true
        }
      }
    })
  }

  await tPromReady
  await tGotScraped

  // 4) Restart bridge
  // a) Shut down bridge
  firstBridgeProc.on('close', () => {
    tBridgeShutdown.pass('Process exited')
  })

  firstBridgeProc.kill('SIGTERM')
  await tBridgeShutdown
  await tPromFailedToScrape // Make sure prom knows the bridge is offline

  // b) Restart bridge
  const restartedBridgeProc = spawn(
    process.execPath,
    [BRIDGE_EXECUTABLE],
    {
      env: {
        ...bridgeEnvVars,
        DHT_PROM_HTTP_PORT: bridgeHttpPort // Reused to simplify the test (we ignore the small chance that the port is already used by another process)
      }
    }
  )

  // To avoid zombie processes in case there's an error
  process.on('exit', () => {
    // TODO: unset this handler on clean run
    restartedBridgeProc.kill('SIGKILL')
  })

  restartedBridgeProc.stderr.on('data', d => {
    console.error(d.toString())
    t.fail('There should be no stderr')
  })

  restartedBridgeProc.on('close', () => {
    tRestartedBridgeShutdown.pass('Process exited')
  })

  {
    let gotScrapedOncePostRe = false
    let gotScrapedOnceSuccessfullyPostRe = false

    let secondClientScrapeReqId = null

    const stdoutDec = new NewlineDecoder('utf-8')
    restartedBridgeProc.stdout.on('data', async d => {
      if (DEBUG) console.log(d.toString())

      for (const line of stdoutDec.push(d)) {
        if (!gotScrapedOncePostRe && line.includes('"url":"/scrape/dummy/metrics"')) {
          tGotScrapedPostRe.pass('Scrape request received from prometheus')
          gotScrapedOncePostRe = true
        }

        if (!gotScrapedOnceSuccessfullyPostRe && line.includes('"statusCode":200')) {
          tGotScrapedPostRe.pass('Scraped successfully (aliases correctly loaded on restart)')
          gotScrapedOnceSuccessfullyPostRe = true
        }

        if (line.includes('Alias request from')) {
          tAlias2Req.pass('Received second alias request')
        }

        if (line.includes('Alias success')) {
          tAlias2Req.pass('Successfully processed second alias request')
        }

        if (!secondClientScrapeReqId && line.includes('secondummy/metrics')) {
          tClient2GotScraped.pass('Scrape req received for client2 (prometheus config got reloaded)')
          secondClientScrapeReqId = JSON.parse(line).reqId
        }

        // Note: Small chance of false positive if another req id starts the same
        const secondClientScraped = secondClientScrapeReqId !== null
        if (secondClientScraped && line.includes(secondClientScrapeReqId) && line.includes('"statusCode":200')) {
          tClient2GotScraped.pass('Scraped successfully (client2)')
        }
      }
    })
  }

  await tGotScrapedPostRe

  // 5) Add another client
  {
    const client2 = getClient(
      t,
      testnet.bootstrap,
      scraperPubKey,
      sharedSecret,
      { name: 'secondummy' }
    )

    client2.on('register-alias-error', e => {
      console.error(e)
      t.fail('Error when client tried to register alias')
    })
    await client2.ready()
  }

  await tAlias2Req
  await tClient2GotScraped

  const promClosed = new Promise(resolve => {
    promProc.on('close', resolve)
  })
  promProc.kill('SIGTERM')

  restartedBridgeProc.kill('SIGTERM')

  await Promise.all([tRestartedBridgeShutdown, promClosed])
})

function getClient (t, bootstrap, scraperPubKey, sharedSecret, { name = 'dummy' } = {}) {
  const dhtClient = new HyperDHT({ bootstrap })
  const dhtPromClient = new DhtPromClient(
    dhtClient,
    promClient,
    idEnc.decode(scraperPubKey),
    name,
    sharedSecret,
    'my-service',
    { bootstrap, hostname: 'my-hostname' }
  )

  t.teardown(async () => {
    await dhtPromClient.close()
    // TODO: investigate why this takes a few sec
  }, 1)

  return dhtPromClient
}

async function writePromConfig (loc, bridgeHttpAddress, promTargetsLoc) {
  bridgeHttpAddress = bridgeHttpAddress.split('://')[1] // Get rid of http://

  const content = `
global:
  scrape_interval:     1s
  evaluation_interval: 1s

scrape_configs:
- job_name: 'dht-prom-redirects'
  file_sd_configs:
  - files:
    - '${promTargetsLoc}'
  relabel_configs:
    - source_labels: [__address__]
      regex: "(.+):.{52}:.+"
      replacement: "$1"
      target_label: instance
    - source_labels: [instance]
      replacement: "/scrape/$1/metrics"
      target_label: __metrics_path__ # => instead of default /metrics
    - source_labels: [__address__]
      regex: ".+:.{52}:([^:]+):.+"
      replacement: "$1"
      target_label: hostname
    - source_labels: [__address__]
      regex: ".+:.{52}:[^:]+:(.+)"
      replacement: "$1"
      target_label: service
    - source_labels: [__address__]
      replacement: "${bridgeHttpAddress}"
      target_label: __address__
`

  await fs.promises.writeFile(loc, content)
}
