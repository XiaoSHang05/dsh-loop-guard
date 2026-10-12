/**
 * What are the cycle hits in the real corpus, exactly?
 *
 * `struct-real-fp.mjs` reported 142 cycle hits and 0 struct hits over 42,478 honest assistant
 * messages. "Zero struct" is the number this work is about; "142 cycle" is a number about the
 * *older* rule, and an unexplained hit count is how a false-positive rate gets quietly assumed
 * to be zero. This prints each cycle hit's unit so the question "is that a loop or is that an
 * honest answer" can be answered by reading, not by assuming.
 *
 * Usage: node _probe/cycle-sample.mjs [top]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { createDetector } from '../src/detect.js'
import { SESSIONS_DIR } from './env.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CHUNK = 16
const TOP = Number(process.argv[2] ?? 25)

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

const hits = []
let messages = 0
for (const file of logs()) {
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

    const detector = createDetector()
    let fired = null
    for (const part of parts) {
      for (let at = 0; at < part.text.length && fired === null; at += CHUNK) {
        const hit = detector.push(part.kind, part.text.slice(at, at + CHUNK))
        if (hit !== null) fired = hit
      }
      if (fired !== null) break
    }
    if (fired !== null) hits.push({ ...fired, session: file.split(/[\\/]/u).slice(-3)[0] })
  }
}

const byKind = {}
for (const hit of hits) byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1
console.log(`语料：${messages} 条 assistant 消息 · 命中 ${hits.length} 条`)
for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind}: ${count}`)

// Group identical units: one runaway that happens in twenty sessions is one shape, not twenty.
const groups = new Map()
for (const hit of hits) {
  const key = hit.kind + '|' + hit.unit
  const entry = groups.get(key) ?? { kind: hit.kind, unit: hit.unit, repeats: hit.repeats, count: 0, streams: new Set() }
  entry.count += 1
  entry.streams.add(hit.stream)
  groups.set(key, entry)
}
const sorted = [...groups.values()].sort((a, b) => b.count - a.count)
console.log(`\n★ 去重后 ${sorted.length} 种不同片段（前 ${TOP} 种）：`)
for (const group of sorted.slice(0, TOP)) {
  console.log(`  ×${String(group.count).padStart(4)}  [${[...group.streams].join('/')}] ${group.kind} rep=${group.repeats}`)
  console.log(`        ${JSON.stringify(group.unit.slice(0, 120))}`)
}
