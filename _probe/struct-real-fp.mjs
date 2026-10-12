/**
 * Ground truth for the skeleton rule: every assistant message this machine has ever written,
 * fed through the real detector.
 *
 * The sweeps before this one measured *runs* — abstract (lines, chars, letters) tuples read out
 * of a cache. A run is what the rule is about, but a cache is a second implementation of the
 * same idea, and two implementations can agree with each other and disagree with the product.
 * So this probe imports `createDetector` and replays the corpus through it, in chunks, exactly
 * the way the host feeds it.
 *
 * What it prints is the number that matters and the only number worth quoting: how many honest
 * messages out of 32,123 would have raised an alarm.
 *
 * Usage: node _probe/struct-real-fp.mjs [chunkChars]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { createDetector } from '../src/detect.js'
import { SESSIONS_DIR } from './env.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHUNK = Number(process.argv[2] ?? 16)

function frames(file) {
  const raw = readFileSync(file)
  const starts = []
  let at = raw.indexOf(MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = raw.indexOf(MAGIC, at + 4)
  }
  const out = []
  for (let i = 0; i < starts.length; i += 1) {
    const slice = raw.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : raw.length)
    try {
      out.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      // one bad frame is not worth failing the read
    }
  }
  return out.join('')
}

function partsOf(value, out) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) partsOf(item, out)
    return
  }
  if (typeof value.text === 'string' && (value.type === 'text' || value.type === 'reasoning')) {
    out.push({ kind: value.type === 'reasoning' ? 'thinking' : 'text', text: value.text })
    return
  }
  for (const key of Object.keys(value)) partsOf(value[key], out)
}

function logs() {
  if (!existsSync(SESSIONS_DIR)) return []
  const out = []
  // `sessions/<workspace>/<session>/session.v4.jsonl.zstd` — two levels, not one. Walking to a
  // fixed depth found nothing and reported a clean corpus, which is the worst possible failure
  // mode for a false-positive count: an empty result that looks like a pass.
  for (const workspace of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const root = join(SESSIONS_DIR, workspace.name)
    for (const session of readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(root, session.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) out.push(file)
    }
  }
  return out
}

const files = logs()
let messages = 0
const hits = []

for (const file of files) {
  const text = frames(file)
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const type = record.type ?? record.event?.type
    if (type !== 'assistant/message' && type !== 'assistant/attempt') continue
    const parts = []
    partsOf(record.data ?? record.payload ?? record, parts)
    if (parts.length === 0) continue
    messages += 1

    // One detector per message, fed in chunks, the way a live stream arrives.
    const detector = createDetector()
    let fired = null
    for (const part of parts) {
      for (let at = 0; at < part.text.length && fired === null; at += CHUNK) {
        const hit = detector.push(part.kind, part.text.slice(at, at + CHUNK))
        if (hit !== null) fired = { ...hit, file: file.split(/[\\/]/u).slice(-3)[0] }
      }
      if (fired !== null) break
    }
    if (fired !== null) hits.push(fired)
  }
}

const byKind = {}
for (const hit of hits) byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1

console.log(`语料：${files.length} 份日志 · ${messages} 条 assistant 消息 · 每 ${CHUNK} 字一段`)
console.log(`命中：${hits.length} 条`)
for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`)

const structs = hits.filter((hit) => hit.kind === 'struct')
if (structs.length > 0) {
  console.log()
  console.log('★ 被骨架规则命中的（人工判断哪些是真循环、哪些是误报）：')
  for (const hit of structs.slice(0, 40)) {
    console.log(`  [${hit.stream}] ${hit.repeats} 行 ${hit.file}`)
    console.log(`      ${JSON.stringify(hit.unit.slice(0, 110))}`)
  }
}
