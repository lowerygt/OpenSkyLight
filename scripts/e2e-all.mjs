// Runs every e2e suite against the built app (npm run build first), one at a
// time, and exits non-zero if any fail.
//   node scripts/e2e-all.mjs            all suites
//   node scripts/e2e-all.mjs --offline  skip suites that need the internet (CI)
//   node scripts/e2e-all.mjs timer pin  run just these suites
import { spawnSync } from 'node:child_process'

const ALL = [
  'smoke', 'pin', 'ics', 'chores', 'lists', 'home', 'theme', 'news', 'camera',
  'weather', 'kiosk', 'companion', 'birdnet', 'timer'
]
const NEEDS_INTERNET = new Set(['weather', 'news'])

const args = process.argv.slice(2)
const offline = args.includes('--offline')
const picked = args.filter((a) => !a.startsWith('--'))
const suites = (picked.length ? picked : ALL).filter((s) => !(offline && NEEDS_INTERNET.has(s)))

const failed = []
for (const suite of suites) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [`scripts/e2e-${suite}.mjs`], { encoding: 'utf8' })
  const secs = ((Date.now() - started) / 1000).toFixed(0)
  if (run.status === 0) {
    console.log(`PASS ${suite} (${secs}s)`)
  } else {
    failed.push(suite)
    console.log(`FAIL ${suite} (${secs}s)`)
    const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n')
    console.log(tail.replace(/^/gm, '    '))
  }
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`)
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`)
  process.exit(1)
}
