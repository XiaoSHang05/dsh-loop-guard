/**
 * The real corpus: every assistant message this machine has ever logged.
 *
 * Every negative sample in `struct-probe.mjs` and `struct-hard.mjs` was written by the same
 * person who wrote the detector, which is the classic way to build a test that passes. The
 * shapes I thought of are the shapes I guarded against; the shapes I did not think of are
 * exactly the ones that will fire in the field.
 *
 * This machine has a better corpus than I can invent: real turns from real models, saved by
 * DSH itself. Hundreds of messages of genuine prose, genuine tables, genuine numbered lists,
 * genuine code — written without any knowledge that a detector was coming.
 *
 * Session logs are a concatenation of zstd frames, so they are split on the magic number and
 * decompressed one at a time; `zstdDecompressSync` on the whole file returns only the first
 * frame, which is a header.
 *
 *   node _probe/struct-real.mjs            # false-positive census over every session
 *   node _probe/struct-real.mjs --dump N   # print the N heaviest runs with their source
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { SESSIONS_DIR } from './env.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Every concatenated zstd frame in one log, joined. */
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
      // A frame that will not decompress on its own is not worth failing the read.
    }
  }
  return out.join('')
}

/** One assistant message's text, pulled out of whatever shape the event uses. */
function textsOf(value, out) {
  if (typeof value === 'string') return
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) textsOf(item, out)
    return
  }
  // A part is `{type: 'text'|'reasoning', text: '...'}` in the committed stream.
  if (typeof value.text === 'string' && (value.type === 'text' || value.type === 'reasoning')) {
    out.push({ kind: value.type === 'reasoning' ? 'thinking' : 'text', text: value.text })
    return
  }
  for (const key of Object.keys(value)) textsOf(value[key], out)
}

function collect() {
  const messages = []
  let sessions = 0
  let logs = 0

  for (const workspace of readdirSync(SESSIONS_DIR)) {
    const workspaceDir = join(SESSIONS_DIR, workspace)
    let sessionIds
    try {
      sessionIds = readdirSync(workspaceDir)
    } catch {
      continue
    }
    for (const sessionId of sessionIds) {
      const dir = join(workspaceDir, sessionId)
      let file = null
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
        try {
          if (statSync(join(dir, name)).isFile()) {
            file = join(dir, name)
            break
          }
        } catch {
          // try the next name
        }
      }
      if (file === null) continue
      sessions += 1

      let text
      try {
        text = frames(file)
      } catch {
        continue
      }
      logs += 1

      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
        const parts = []
        textsOf(event.data ?? event.payload ?? event, parts)
        for (const part of parts) {
          if (part.text.trim() !== '') messages.push({ sessionId, ...part })
        }
      }
    }
  }

  return { messages, sessions, logs }
}

// ── the candidate rule, identical to the one under test ────────────────────────────────────

const MIN_LINES = 4
const SKIP_DIRS = new Set()

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

function isBlank(line) {
  return line.trim() === ''
}

function hasContent(text) {
  const seen = new Set()
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') continue
    seen.add(ch)
    if (seen.size >= 2) return true
  }
  return false
}

/** Heaviest run of >= MIN_LINES consecutive lines sharing a skeleton. */
function heaviest(text) {
  const lines = text.split('\n').filter((line) => !isBlank(line))
  let best = { lines: 0, chars: 0, sample: '', key: '' }
  let run = 0
  let chars = 0
  let current = ''

  for (const line of lines) {
    const key = skeleton(line)
    const usable = hasContent(key) && key.length >= 4
    if (usable && key === current) {
      run += 1
      chars += line.length
    } else {
      run = usable ? 1 : 0
      chars = usable ? line.length : 0
      current = usable ? key : ''
    }
    if (run >= MIN_LINES && chars > best.chars) best = { lines: run, chars, sample: line, key: current }
  }
  return best
}

const args = process.argv.slice(2)
const dumpAt = args.indexOf('--dump')

const { messages, sessions, logs } = collect()
console.log(`\n${'═'.repeat(80)}`)
console.log('真实语料：这台机器上 DSH 自己记下的全部 assistant 消息')
console.log('═'.repeat(80))
console.log(`  ${logs} 份日志 / ${sessions} 个会话 / ${messages.length} 条消息`)

const thinking = messages.filter((m) => m.kind === 'thinking')
const text = messages.filter((m) => m.kind === 'text')
const chars = messages.reduce((sum, m) => sum + m.text.length, 0)
console.log(`  thinking ${thinking.length} 条 (${thinking.reduce((s, m) => s + m.text.length, 0).toLocaleString()} 字)`)
console.log(`  text     ${text.length} 条 (${text.reduce((s, m) => s + m.text.length, 0).toLocaleString()} 字)`)
console.log(`  合计 ${chars.toLocaleString()} 字`)

const runs = []
for (const message of messages) {
  const seen = heaviest(message.text)
  if (seen.lines >= MIN_LINES) runs.push({ ...seen, ...message })
}
runs.sort((a, b) => b.chars - a.chars)

console.log(`\n  出现 ≥${MIN_LINES} 行骨架连跑的消息：${runs.length} / ${messages.length}`)
const buckets = { '≤300': 0, '300-600': 0, '600-1000': 0, '1000-1600': 0, '1600-2400': 0, '≥2400': 0 }
for (const run of runs) {
  const key =
    run.chars <= 300 ? '≤300'
    : run.chars <= 600 ? '300-600'
    : run.chars <= 1000 ? '600-1000'
    : run.chars <= 1600 ? '1000-1600'
    : run.chars <= 2400 ? '1600-2400'
    : '≥2400'
  buckets[key] += 1
}
for (const [key, count] of Object.entries(buckets)) {
  const bar = '█'.repeat(Math.min(50, Math.round((count / Math.max(1, runs.length)) * 50)))
  console.log(`  ${key.padEnd(12)} ${String(count).padStart(4)} 条  ${bar}`)
}

const show = dumpAt === -1 ? 12 : Number(args[dumpAt + 1] ?? 12)
console.log(`\n  —— 最重的 ${show} 处 ——`)
for (const run of runs.slice(0, show)) {
  const sample = run.sample.length > 60 ? run.sample.slice(0, 59) + '…' : run.sample
  console.log(`\n  ${run.chars} 字 / ${run.lines} 行  [${run.kind}]  ${sample}`)
  console.log(`  ↳ ${run.sessionId}`)
}

const worst = runs[0]
console.log(`\n${'═'.repeat(80)}`)
console.log('★ 结论')
console.log('═'.repeat(80))
if (worst === undefined) {
  console.log('  真实语料里没有任何 ≥4 行的骨架连跑 ⇒ 这个规则在这台机器的历史上零误报')
} else {
  console.log(`  真实语料里最重的骨架连跑：${worst.chars} 字 / ${worst.lines} 行（${worst.kind}）`)
  console.log(`  它长这样：${worst.sample.slice(0, 100)}`)
  console.log(`\n  ⇒ 预算取 ${worst.chars + 1} 字以上，在这批真实输出上零误报`)
}
