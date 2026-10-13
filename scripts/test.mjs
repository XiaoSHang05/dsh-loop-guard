/**
 * Run every harness and report one line each.
 *
 * A harness is a script that mounts a real half and drives it, printing `PASS`/`FAIL` lines and
 * exiting non-zero on the first bad one. They deliberately do NOT share a summary format — the
 * detection bench says `detect: 48/48 checks passed`, the client benches say `ALL 11 PASS` — so
 * this runner quotes the last non-empty stdout line rather than grepping for a phrase. A runner
 * that insisted on one wording would silently report `ok` for a bench that failed loudly in a
 * different dialect.
 *
 * Order matters for reading the output: the detection core first (it is the thing everything
 * else is about), then the host half, then the seam, then the browser half.
 */

import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const run = promisify(execFile)

const HARNESSES = [
  ['detect: core rules', '_probe/detect.mjs'],
  ['host: routes', '_probe/host/routes.mjs'],
  ['host: stream', '_probe/host/stream.mjs'],
  ['host: one turn end to end', '_probe/host/repl.mjs'],
  ['client: store + alarm', '_probe/client/alarm.mjs'],
  ['client: store + stream', '_probe/client/stream.mjs'],
  ['contract: wire', '_probe/contract/wire.mjs'],
  ['client: mount', '_probe/render/mount.mjs'],
]

async function main() {
  let failed = 0
  for (const [label, relative] of HARNESSES) {
    try {
      const { stdout } = await run(process.execPath, [join(root, relative)], { cwd: root })
      const summary = stdout.trim().split('\n').filter((line) => line.trim() !== '').pop()
      console.log(`${label}: ${summary ?? 'ok'}`)
    } catch (error) {
      failed += 1
      console.log(`${label}: FAILED`)
      const detail = String(error.stdout || error.stderr || error.message).trim()
      if (detail !== '') console.log(detail.split('\n').map((line) => `    ${line}`).join('\n'))
    }
  }
  console.log('')
  if (failed > 0) {
    console.log(`${failed} harness(es) failed`)
    process.exitCode = 1
    return
  }
  console.log('all harnesses passed')
}

await main()
