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

const DEBUG = true

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

  const testnet = await createTestnet()
  t.teardown(async () => await testnet.destroy(), 1000)

  const tmpDir = await getTmpDir()
  const promTargetsLoc = path.join(tmpDir, 'prom-targets.json')
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

      if (line.includes('Fully shut down')) {
        tBridgeShutdown.pass('Shut down cleanly')
      }
    }
  })

  await tBridgeSetup

  // 2) Setting up a client
  const client = getClient(t, testnet.bootstrap, scraperPubKey, sharedSecret)
  client.on('register-alias-error', e => {
    console.error(e)
    t.fail('Error when client tried to register alias')
  })
  await client.ready()

  await tAliasReq

  // 3) Shut down bridge
  firstBridgeProc.on('close', () => {
    tBridgeShutdown.pass('Process exited')
  })

  firstBridgeProc.kill('SIGTERM')

  await tBridgeShutdown

  console.log(bridgeHttpAddress)
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
