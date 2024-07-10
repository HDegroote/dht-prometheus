const fsProm = require('fs/promises')

async function writePromTargets (location, targets, pubKeys) {
  const content = [
    {
      labels: {
        job: 'aliases'
      },
      targets,
      // irrelevant for prometheus but needed for us
      // to restore from the prometheus file
      pubKeys
    }
  ]

  await fsProm.writeFile(location, JSON.stringify(content, null, 1), { encoding: 'utf-8' })
}

async function readPromTargets (location) {
  // Throws if file not found or invalid JSON
  const content = await fsProm.readFile(location, { encoding: 'utf-8' })
  const fullJson = JSON.parse(content)
  const targets = fullJson[0].targets
  const pubKeys = fullJson[0].pubKeys
  return [targets, pubKeys]
}

module.exports = {
  writePromTargets,
  readPromTargets
}
