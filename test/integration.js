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

  const testnet = await createTestnet()

  const tmpDir = await getTmpDir()
  const promTargetsLoc = path.join(tmpDir, 'prom-targets.json')
  const sharedSecret = idEnc.normalize(hypCrypto.randomBytes(32))

  const firstBridgeProc = spawn(
    process.execPath,
    [BRIDGE_EXECUTABLE],
    {
      env: {
        DHT_PROM_PROMETHEUS_TARGETS_LOC: promTargetsLoc,
        DHT_PROM_SHARED_SECRET: sharedSecret,
        DHT_PROM_BOOTSTRAP_PORT: testnet.bootstrap.port
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

  const stdoutDec = new NewlineDecoder('utf-8')
  firstBridgeProc.stdout.on('data', async d => {
    if (DEBUG) console.log(d.toString())

    for (const line of stdoutDec.push(d)) {
      if (line.includes('Server listening at')) {
        bridgeHttpAddress = line.match(/http:\/\/127.0.0.1:[0-9]{3,5}/)[0]
        tBridgeSetup.pass('http server running')
      }

      if (line.includes('DHT RPC ready at')) {
        tBridgeSetup.pass('dht rpc service running')
      }

      if (line.includes('Fully shut down')) {
        tBridgeShutdown.pass('Shut down cleanly')
      }
    }
  })

  await tBridgeSetup

  firstBridgeProc.on('close', () => {
    tBridgeShutdown.pass('Process exited')
  })

  firstBridgeProc.kill('SIGTERM')

  await tBridgeShutdown

  await testnet.destroy()

  // console.log(bridgeHttpAddress)
})
