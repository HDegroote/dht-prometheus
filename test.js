const test = require('brittle')
const PrometheusDhtBridge = require('./index')
const promClient = require('prom-client')
const DhtPromClient = require('dht-prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const fastify = require('fastify')
const axios = require('axios')

test('put alias + lookup happy flow', async t => {
  const { bridge, dhtPromClient } = await setup(t)

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen()

  bridge.putAlias('dummy', dhtPromClient.publicKey)

  const res = await axios.get(`${baseUrl}/scrape/dummy/metrics`)
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

  const dht = new HyperDHT({ bootstrap })
  const server = fastify() // TODO: no logs
  const bridge = new PrometheusDhtBridge(dht, server, { address: '127.0.0.1', port: 30000 })
  const scraperPubKey = bridge.publicKey

  const dhtClient = new HyperDHT({ bootstrap })
  const dhtPromClient = new DhtPromClient(dhtClient, promClient, scraperPubKey)

  t.teardown(async () => {
    await server.close()
    await dhtPromClient.close()
    await dht.destroy()
    await testnet.destroy()
  })

  return { dhtPromClient, bridge, bootstrap }
}
