// 1) Start bridge which scrapes every second
// 2) start a service (which autoregisters)
// 3) Verify it's scraped
// 4) restart the bridge
// 5) Verify the bridge loads same config
// 6) verify service scraped
// 7) restart service
// 8) verify it reregisters the new pub key
// 9) Verify it's scraped successfully

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

const BRIDGE_EXECUTABLE = path.join(path.dirname(__dirname), 'run.js')
const PROMETHEUS_EXECUTABLE = path.join(path.dirname(__dirname), 'prometheus', 'prometheus')

const DEBUG = false

// To force the process.on('exit') to be called on those exits too
process.prependListener('SIGINT', () => process.exit(1))
process.prependListener('SIGTERM', () => process.exit(1))

test('Integration test, happy path', async t => {
  if (!fs.existsSync(PROMETHEUS_EXECUTABLE)) {
    throw new Error('the integration test requires a prometheus exec')
  }

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

  const testnet = await createTestnet()
  t.teardown(async () => await testnet.destroy(), 1000)

  const tmpDir = await getTmpDir()
  const promTargetsLoc = path.join(tmpDir, 'targets.json')
  const sharedSecret = hypCrypto.randomBytes(32)
  const z32SharedSecret = idEnc.normalize(sharedSecret)

  // 1) Setup the bridge
  const firstBridgeProc = spawn(
    process.execPath,
    [BRIDGE_EXECUTABLE],
    {
      env: {
        DHT_PROM_PROMETHEUS_TARGETS_LOC: promTargetsLoc,
        DHT_PROM_SHARED_SECRET: z32SharedSecret,
        DHT_PROM_BOOTSTRAP_PORT: testnet.bootstrap[0].port,
        _DHT_PROM_FORCE_FLUSH: true

      }
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
  const client = getClient(t, testnet.bootstrap, scraperPubKey, sharedSecret)
  client.on('register-alias-error', e => {
    console.error(e)
    t.fail('Error when client tried to register alias')
  })
  await client.ready()

  await tAliasReq

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
    promProc.stderr.on('data', d => {
      if (DEBUG) console.log('PROMETHEUS', d.toString())

      for (const line of stdoutDec.push(d)) {
        if (line.includes('Server is ready to receive web requests')) {
          tPromReady.pass('Prometheus ready')
        }
      }
    })
  }

  await tPromReady
  await tGotScraped

  // Shut down bridge
  firstBridgeProc.on('close', () => {
    tBridgeShutdown.pass('Process exited')
  })

  firstBridgeProc.kill('SIGTERM')
  promProc.kill('SIGTERM') // TODO: wait for exit
  await tBridgeShutdown
})

function getClient (t, bootstrap, scraperPubKey, sharedSecret) {
  promClient.collectDefaultMetrics() // So we have something to scrape

  const dhtClient = new HyperDHT({ bootstrap })
  const dhtPromClient = new DhtPromClient(
    dhtClient,
    promClient,
    idEnc.decode(scraperPubKey),
    'dummy',
    sharedSecret,
    { bootstrap }
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
      regex: "(.+):.{52}" # Targets are structured as <targetname>:<target z32 key>, and at prometheus level we only need the key
      replacement: "/scrape/$1/metrics" # Captured part + /metrics appendix
      target_label: __metrics_path__ # => instead of default /metrics
    - source_labels: [__address__]
      replacement: "${bridgeHttpAddress}"
      target_label: __address__       # => That's the actual address
`

  await fs.promises.writeFile(loc, content)
}
