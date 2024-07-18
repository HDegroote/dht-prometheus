const fsProm = require('fs/promises')
const idEnc = require('hypercore-id-encoding')

async function writePromTargets (location, aliases) {
  const targets = []
  // DEVNOTE: a bit ugly we know about scrapeClient here,
  // but easier to just pass in the full aliases map
  // than to extract the pubkey in the caller
  for (const [target, scrapeClient] of aliases) {
    const pubKey = idEnc.normalize(scrapeClient.targetKey)
    targets.push(`${target}:${pubKey}`)
  }

  const content = [
    {
      labels: {
        job: 'aliases'
      },
      targets
    }
  ]

  await fsProm.writeFile(location, JSON.stringify(content, null, 1), { encoding: 'utf-8' })
}

async function readPromTargets (location) {
  // Throws if file not found or invalid JSON
  const content = await fsProm.readFile(location, { encoding: 'utf-8' })
  const fullJson = JSON.parse(content)

  const aliases = new Map()
  for (const target of fullJson[0].targets) {
    const [alias, z32PubKey] = target.split(':')
    aliases.set(alias, z32PubKey)
  }

  return aliases
}

module.exports = {
  writePromTargets,
  readPromTargets
}
