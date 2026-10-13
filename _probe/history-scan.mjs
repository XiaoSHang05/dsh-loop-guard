// What is in this repository's history, asked of the history rather than of the working tree.
// A needle a reader can find with `git log -p` is published, whether or not the current
// checkout still contains it — so the check has to read the whole history, not `git grep`.
//
//   git log --all -p --no-color > history.txt
//   node _probe/history-scan.mjs history.txt
//
// The dump is produced by git rather than by this script on purpose: spawning git from inside
// a sandboxed Node process is not always allowed, and a scanner that cannot run is a scanner
// nobody runs. Reading a file works everywhere.
import { readFile } from 'node:fs/promises'

const NEEDLES = [
  // At least two characters for the account name: `C:\Users\x\.dsh` is a placeholder in a
  // doc comment, and a one-character account name is not a thing.
  ['home directory', /[A-Z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9][A-Za-z0-9._-]+/gu],
  ['unix home', /\/(?:home|Users)\/[A-Za-z0-9][A-Za-z0-9._-]+\//gu],
  ['session id', /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu],
  ['token', /\b(?:gho_|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/gu],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{12,}/gu],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu],
]

const path = process.argv[2]
if (path === undefined) {
  console.error('usage: git log --all -p --no-color > history.txt && node _probe/history-scan.mjs history.txt')
  process.exit(2)
}

const text = await readFile(path, 'utf8')
const hits = []
for (const [label, pattern] of NEEDLES) {
  pattern.lastIndex = 0
  const seen = new Set()
  for (const match of text.matchAll(pattern)) {
    if (seen.has(match[0])) continue
    seen.add(match[0])
    hits.push({ label, sample: match[0] })
  }
}

if (hits.length === 0) {
  console.log('history-scan: no needles found')
} else {
  for (const { label, sample } of hits) console.log(`history-scan: ${label}: ${sample}`)
  console.log(`history-scan: ${hits.length} needle(s) found`)
  process.exitCode = 1
}
