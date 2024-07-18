const test = require('brittle')
const promClient = require('prom-client')
const DhtPromClient = require('dht-prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const fastify = require('fastify')
const axios = require('axios')
const hypCrypto = require('hypercore-crypto')
const getTmpDir = require('test-tmp')
const path = require('path')
const PrometheusDhtBridge = require('../index')

test('put alias + lookup happy flow', async t => {
  const { bridge, dhtPromClient } = await setup(t)

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  bridge.putAlias('dummy', dhtPromClient.publicKey)
  await bridge.swarm.flush() // Avoid race condition

  const res = await axios.get(
    `${baseUrl}/scrape/dummy/metrics`,
    { validateStatus: null }
  )
  t.is(res.status, 200, 'correct status')
  t.is(
    res.data.includes('process_cpu_user_seconds_total'),
    true,
    'Successfully scraped metrics'
  )
})

test('404 on unknown alias', async t => {
  const { bridge } = await setup(t)

  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  const res = await axios.get(
    `${baseUrl}/scrape/nothinghere/metrics`,
    { validateStatus: null }
  )
  t.is(res.status, 404, 'correct status')
  t.is(
    res.data.includes('Unknown alias'),
    true,
    'Sensible err msg'
  )
})

test('502 with uid if upstream returns success: false', async t => {
  const { bridge, dhtPromClient } = await setup(t)

  new promClient.Gauge({ // eslint-disable-line no-new
    name: 'broken_metric',
    help: 'A metric which throws on collecting it',
    collect () {
      throw new Error('I break stuff')
    }
  })

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid }) => {
    reqUid = uid
  })

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })
  bridge.putAlias('dummy', dhtPromClient.publicKey)
  await bridge.swarm.flush() // Avoid race condition

  const res = await axios.get(
    `${baseUrl}/scrape/dummy/metrics`,
    { validateStatus: null }
  )
  t.is(res.status, 502, 'correct status')
  t.is(
    res.data.includes(reqUid),
    true,
    'uid included in error message'
  )
})

test('502 if upstream unavailable', async t => {
  const { bridge, dhtPromClient } = await setup(t)

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })
  bridge.putAlias('dummy', dhtPromClient.publicKey)

  await dhtPromClient.close()

  const res = await axios.get(
    `${baseUrl}/scrape/dummy/metrics`,
    { validateStatus: null }
  )
  t.is(res.status, 502, 'correct status')
  t.is(
    res.data,
    'Upstream unavailable',
    'uid included in error message'
  )
})

test('No new alias if adding same key', async t => {
  const { bridge } = await setup(t)
  const key = 'a'.repeat(64)
  const key2 = 'b'.repeat(64)

  await bridge.ready()
  bridge.putAlias('dummy', key)
  const clientA = bridge.aliases.get('dummy')

  t.is(clientA != null, true, 'sanity check')
  bridge.putAlias('dummy', key)
  t.is(clientA, bridge.aliases.get('dummy'), 'no new client')

  t.is(clientA.closing == null, true, 'sanity check')
  bridge.putAlias('dummy', key2)
  t.not(clientA, bridge.aliases.get('dummy'), 'sanity check')
  t.is(clientA.closing != null, true, 'lifecycle ok')
})

test('A client which registers itself can get scraped', async t => {
  t.plan(4)

  const { bridge, dhtPromClient } = await setup(t)

  await bridge.ready()

  bridge.aliasRpcServer.on('alias-request', ({ uid, remotePublicKey, alias, targetPublicKey }) => {
    t.is(alias, 'dummy', 'correct alias')
    t.alike(targetPublicKey, dhtPromClient.publicKey, 'correct target key got registered')
  })
  bridge.aliasRpcServer.on('register-error', ({ error, uid }) => {
    console.error(error)
    t.fail('unexpected error')
  })

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  await bridge.swarm.flush() // To avoid race conditions
  await dhtPromClient.ready()

  const res = await axios.get(
    `${baseUrl}/scrape/dummy/metrics`,
    { validateStatus: null }
  )
  t.is(res.status, 200, 'correct status')
  t.is(
    res.data.includes('process_cpu_user_seconds_total'),
    true,
    'Successfully scraped metrics'
  )
})

async function setup (t) {
  promClient.collectDefaultMetrics() // So we have something to scrape
  t.teardown(() => promClient.register.clear())

  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const sharedSecret = hypCrypto.randomBytes(32)

  const dht = new HyperDHT({ bootstrap })
  const server = fastify({ logger: false })
  const tmpDir = await getTmpDir(t)
  const prometheusTargetsLoc = path.join(tmpDir, 'prom-targets.json')
  const bridge = new PrometheusDhtBridge(dht, server, sharedSecret, {
    _forceFlushOnClientReady: true, // to avoid race conditions
    prometheusTargetsLoc
  })
  const scraperPubKey = bridge.publicKey

  const dhtClient = new HyperDHT({ bootstrap })
  const dhtPromClient = new DhtPromClient(
    dhtClient,
    promClient,
    scraperPubKey,
    'dummy',
    sharedSecret,
    { bootstrap }
  )

  t.teardown(async () => {
    await server.close()
    await bridge.close()
    await dhtPromClient.close()
    await dht.destroy()
    await testnet.destroy()
  })

  const ownPublicKey = dhtPromClient.dht.defaultKeyPair.publicKey
  return { dhtPromClient, bridge, bootstrap, ownPublicKey }
}
