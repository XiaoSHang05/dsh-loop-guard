/**
 * The second half of the hard bone: cycles whose lines are all *different* from each other.
 *
 * `struct-sweep.mjs` measured runs of consecutive same-skeleton lines. That covers the counter
 * loop — "第 1 步：…", "第 2 步：…" — because every line has the same skeleton, so they stack
 * into one run.
 *
 * It cannot see the other shape at all. The user described it as:
 *
 *     一 / 二 / 四 / 一 / 二 / 四 / …
 *
 * No two adjacent lines match, so there is no run to find, and no character period either
 * because "一" never repeats contiguously. The repetition lives one level up: the *sequence of
 * lines* comes back around. That is a cycle in the line array, and it needs the line array as
 * its unit of comparison — the same period search `scanCycle` already does for characters,
 * moved up a level.
 *
 * Both rules are measured here against the real corpus, in the same cache, so the thresholds
 * are chosen from the same evidence:
 *
 *   key space A = skeleton (digits → #)   — "第 1 步" and "第 2 步" are one key
 *   key space B = exact normalized text   — "一" and "二" are two keys
 *
 * A rule fires when the smallest period that reaches `minRepeat` copies is found. Period 1 in
 * space B is deliberately excluded: that is "the same line over and over", which `density`
 * already owns, and which would otherwise fire on every divider and every markdown rule.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { SESSIONS_DIR } from './env.mjs'

const CACHE = new URL('./struct-lines-cache.json', import.meta.url)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PMAX = 12

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

function textsOf(value, out) {
  if (typeof value === 'string') return
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) textsOf(item, out)
    return
  }
  if (typeof value.text === 'string' && (value.type === 'text' || value.type === 'reasoning')) {
    out.push({ kind: value.type === 'reasoning' ? 'thinking' : 'text', text: value.text })
    return
  }
  for (const key of Object.keys(value)) textsOf(value[key], out)
}

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

function normalize(line) {
  return line.trim().replace(/\s+/gu, ' ')
}

/**
 * Largest number of whole copies of a period-`P` block at the tail of `keys`.
 *
 * Counted the way `runLength` counts characters: how far back the equality holds, divided by
 * the period. `cap` stops the walk at `cap` copies, because proving a threshold costs that
 * many copies and nothing more.
 *
 * The cap is the reason this function reports a number rather than a boolean. An earlier pass
 * of this measurement built its cache with `cap = 4` and then read a grid whose `>=6` and
 * `>=8` columns were all zero — not because the corpus was clean, but because those counts
 * could not be reached. A threshold table full of structurally impossible zeros looks exactly
 * like a clean result, which is the worst way for a measurement to be wrong.
 */
function copiesAtTail(keys, period, cap) {
  const n = keys.length
  const max = Math.min(cap * period, n - period)
  let matched = 0
  while (matched < max) {
    if (keys[n - 1 - matched] !== keys[n - 1 - matched - period]) break
    matched += 1
  }
  return matched >= period ? Math.floor(matched / period) + 1 : 0
}

/** The copy cap every cached number was measured under. Thresholds above this are unmeasurable. */
const COPY_CAP = 12

/** The thresholds swept below. Declared here so the cache's cap can be checked against them. */
const PERIODS = [2, 3, 4, 5, 6]
const COPIES = [3, 4, 5, 6, 8, 10]

/** Per key space: `{ [period]: { copies, distinct, chars, sample } }` for every period ≥2. */
function cyclesOf(lines) {
  const out = { exact: {}, skeleton: {} }
  if (lines.length < 8) return out

  for (const [name, keys] of [
    ['exact', lines.map(normalize)],
    ['skeleton', lines.map((line) => skeleton(normalize(line)))],
  ]) {
    for (let period = 2; period <= PMAX; period += 1) {
      if (keys.length < period * 2) break
      const copies = copiesAtTail(keys, period, COPY_CAP)
      if (copies < 2) continue
      const block = keys.slice(keys.length - period)
      const distinct = new Set(block).size
      const chars = lines.slice(lines.length - period).reduce((s, l) => s + l.length, 0)
      out[name][period] = { copies, distinct, chars, sample: lines.slice(lines.length - period).join(' / ') }
    }
  }
  return out
}

if (process.argv.includes('--cache') || !existsSync(CACHE)) {
  const messages = []
  let logs = 0
  for (const workspace of readdirSync(SESSIONS_DIR)) {
    let sessionIds
    try {
      sessionIds = readdirSync(join(SESSIONS_DIR, workspace))
    } catch {
      continue
    }
    for (const sessionId of sessionIds) {
      const dir = join(SESSIONS_DIR, workspace, sessionId)
      let file = null
      for (const name of ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd']) {
        try {
          if (statSync(join(dir, name)).isFile()) {
            file = join(dir, name)
            break
          }
        } catch {
          // next
        }
      }
      if (file === null) continue
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
          if (part.text.trim() === '') continue
          const lines = part.text.split('\n').filter((l) => normalize(l) !== '')
          if (lines.length < 8) continue
          const cycles = cyclesOf(lines)
          if (Object.keys(cycles.exact).length === 0 && Object.keys(cycles.skeleton).length === 0) continue
          messages.push({ sessionId, kind: part.kind, lines: lines.length, chars: part.text.length, cycles })
        }
      }
    }
  }
  writeFileSync(CACHE, JSON.stringify({ logs, messages, copyCap: COPY_CAP }))
  console.log(`cached ${messages.length} messages with a >=2-copy cycle, from ${logs} logs (copy cap ${COPY_CAP})`)
}

const cache = JSON.parse(readFileSync(CACHE, 'utf8'))
const messages = cache.messages
console.log(
  `\n语料：${messages.length} 条消息在行层面出现过 ≥2 遍整块循环（共扫描 ${cache.logs} 份日志，拷贝数上限 ${cache.copyCap}）`,
)
if (cache.copyCap < Math.max(...COPIES)) {
  console.log(`⚠️ 缓存的拷贝数上限是 ${cache.copyCap}，低于要测的 ${Math.max(...COPIES)} 遍 ⇒ 请带 --cache 重跑`)
}

/**
 * A message that is one of the incidents this plugin exists for.
 *
 * A cycle whose block is a single literal sentence repeated — that is the guard's own
 * acceptance case, and it is a true positive, not a false positive.
 */
function isKnownLoop(message) {
  for (const space of ['exact', 'skeleton']) {
    for (const cell of Object.values(message.cycles[space])) {
      if (cell.copies < 20) continue
      const stripped = cell.sample.replace(/\d+/gu, '').replace(/[/|]/gu, '').trim()
      if (stripped.length > 0 && cell.sample.length / Math.max(1, cell.sample.split(' / ').length) <= 40) return true
    }
  }
  return false
}

const real = messages.filter((m) => !isKnownLoop(m))
const loops = messages.filter((m) => isKnownLoop(m))
console.log(`  其中 ${loops.length} 条是已知的真循环，${real.length} 条是正常输出`)

// ── space B: exact line keys, period >= 2 ─────────────────────────────────────────────────

console.log(`\n${'═'.repeat(96)}`)
console.log('★ 空间 B（行原文，周期 ≥2）：每格 = 在真实输出里会误报的消息条数')
console.log('═'.repeat(96))

function worstExact(message, maxPeriod, minCopies) {
  let best = null
  for (const [period, cell] of Object.entries(message.cycles.exact)) {
    if (Number(period) > maxPeriod) continue
    if (cell.distinct < 2 || cell.copies < minCopies) continue
    if (best === null || cell.copies > best.copies) best = cell
  }
  return best
}

process.stdout.write(`${'周期≤'.padEnd(10)}`)
for (const c of COPIES) process.stdout.write(`${`≥${c}遍`.padStart(9)}`)
console.log('')
const survivorsB = []
for (const maxPeriod of PERIODS) {
  process.stdout.write(`${String(maxPeriod).padEnd(10)}`)
  for (const minCopies of COPIES) {
    let hits = 0
    for (const m of real) if (worstExact(m, maxPeriod, minCopies) !== null) hits += 1
    if (hits === 0) survivorsB.push({ maxPeriod, minCopies })
    process.stdout.write(`${(hits === 0 ? '✓0' : String(hits)).padStart(9)}`)
  }
  console.log('')
}

// ── space A: skeleton keys, period >= 2 ───────────────────────────────────────────────────

console.log(`\n${'═'.repeat(96)}`)
console.log('★ 空间 A（骨架键，周期 ≥2）：每格 = 误报条数')
console.log('═'.repeat(96))

function worstSkeleton(message, maxPeriod, minCopies, minChars) {
  let best = null
  for (const [period, cell] of Object.entries(message.cycles.skeleton)) {
    if (Number(period) > maxPeriod) continue
    if (cell.distinct < 2 || cell.copies < minCopies || cell.chars < minChars) continue
    if (best === null || cell.copies > best.copies) best = cell
  }
  return best
}

process.stdout.write(`${'周期≤/字数'.padEnd(14)}`)
for (const c of COPIES) process.stdout.write(`${`≥${c}遍`.padStart(9)}`)
console.log('')
const survivorsA = []
for (const maxPeriod of PERIODS) {
  for (const minChars of [0, 200, 400]) {
    process.stdout.write(`${`${maxPeriod} / ${minChars}`.padEnd(14)}`)
    for (const minCopies of COPIES) {
      let hits = 0
      for (const m of real) if (worstSkeleton(m, maxPeriod, minCopies, minChars) !== null) hits += 1
      if (hits === 0) survivorsA.push({ maxPeriod, minCopies, minChars })
      process.stdout.write(`${(hits === 0 ? '✓0' : String(hits)).padStart(9)}`)
    }
    console.log('')
  }
}

// ── the loops the user actually described ─────────────────────────────────────────────────

console.log(`\n${'═'.repeat(96)}`)
console.log('★ 用户描述的形状：几行抓到（喂到 400 行仍未报就是漏）')
console.log('═'.repeat(96))

const SHAPES = {
  '一 / 二 / 四（三行）': ['一', '二', '四'],
  '一 / 二 / 四（带空行）': ['一', '', '二', '', '四'],
  '甲 / 乙（两行）': ['甲', '乙'],
  '第一条 / 第二条 / 第三条': ['第一条：检查配置', '第二条：检查依赖', '第三条：检查权限'],
  'step a / step b / step c': ['step a: read config', 'step b: read deps', 'step c: read perms'],
}

function latencyLines(block, maxPeriod, minCopies, minChars) {
  const lines = []
  for (let i = 0; i < 400; i += 1) {
    lines.push(block[i % block.length])
    const nonBlank = lines.filter((l) => normalize(l) !== '')
    if (nonBlank.length < 8) continue
    const cycles = cyclesOf(nonBlank)
    const found = Object.entries(cycles.exact).find(([period, c]) => {
      return Number(period) <= maxPeriod && c.distinct >= 2 && c.copies >= minCopies && c.chars >= minChars
    })
    if (found !== undefined) return { at: nonBlank.length, block: found[1] }
  }
  return null
}

const CELLS = survivorsB.length > 0 ? survivorsB : [{ maxPeriod: 6, minCopies: 5 }]
process.stdout.write(`${'形状'.padEnd(30)}`)
for (const cell of CELLS) process.stdout.write(`${`≤${cell.maxPeriod}行/≥${cell.minCopies}遍`.padStart(18)}`)
console.log('')

for (const [name, block] of Object.entries(SHAPES)) {
  process.stdout.write(`${name.padEnd(30)}`)
  for (const cell of CELLS) {
    const seen = latencyLines(block, cell.maxPeriod, cell.minCopies, 0)
    process.stdout.write(`${(seen === null ? '漏' : `${seen.at}行/${seen.block.copies}遍`).padStart(18)}`)
  }
  console.log('')
}

console.log(`\n★ 空间 B 零误报的格子：${survivorsB.length} 个`)
for (const cell of survivorsB) console.log(`  周期 ≤${cell.maxPeriod} · 至少 ${cell.minCopies} 遍`)
console.log(`★ 空间 A 零误报的格子：${survivorsA.length} 个`)
for (const cell of survivorsA.slice(0, 12)) {
  console.log(`  周期 ≤${cell.maxPeriod} · 至少 ${cell.minCopies} 遍 · 块内 ≥${cell.minChars} 字`)
}
