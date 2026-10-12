/**
 * Threshold sweep over the real corpus, cached so it can be swept cheaply.
 *
 * `struct-real.mjs` measured one rule at one threshold. Choosing a threshold needs the whole
 * grid at once, and re-reading 970 million characters for every cell is not a sweep — it is a
 * hundred file reads.
 *
 * So this splits the work in two:
 *
 *   1. `--cache` reads every session log once and writes down, per message, the maximal runs
 *      of consecutive same-skeleton lines. Runs are the only thing a threshold can act on, and
 *      a maximal run covers every sub-run inside it, so the cache is threshold-independent.
 *   2. every later run sweeps the grid against the cache in a second.
 *
 * The known loops in the corpus ("Let me go." repeated until the guard killed it) are reported
 * separately: they are true positives, and counting them as false positives would push the
 * threshold up until the detector stopped working, in the name of a number.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { SESSIONS_DIR } from './env.mjs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
      // not worth failing the read over one bad frame
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

/**
 * Every maximal run of consecutive same-skeleton lines.
 *
 * The cache records the run's *text*, not just its first line, because the interesting question
 * turned out to be what a run is made of rather than how long it is. The heaviest honest run in
 * this corpus is a CAD coordinate listing — 9 lines, 538 characters, 69% digits — and it is
 * indistinguishable from a fake-progress loop by line count or by character weight. It is only
 * distinguishable by how much of it is words. Storing one sample line cannot answer that, so
 * the stats are computed here, once, where the full run is still in hand.
 */
function maximalRuns(text) {
  const out = []
  let run = []
  let current = ''

  const flush = () => {
    if (run.length >= 2) {
      const joined = run.join('\n')
      const digits = (joined.match(/\d/gu) ?? []).length
      const letters = (joined.match(/\p{L}/gu) ?? []).length
      const chars = run.reduce((s, l) => s + l.length, 0)
      const entry = {
        lines: run.length,
        chars,
        sample: run[0],
        digits,
        letters,
        nondigit: joined.length - digits,
      }
      // Only runs heavy enough to be near any threshold need their text kept; the rest are
      // decided by their counts alone, and storing 53k full runs would make the cache the
      // expensive part of the sweep.
      if (chars >= 300) entry.text = joined.length <= 2000 ? joined : joined.slice(0, 2000)
      out.push(entry)
    }
    run = []
  }

  for (const line of text.split('\n')) {
    if (isBlank(line)) {
      flush()
      current = ''
      continue
    }
    const key = skeleton(line)
    if (!hasContent(key) || key.length < 4) {
      flush()
      current = ''
      continue
    }
    if (key === current) {
      run.push(line)
    } else {
      flush()
      current = key
      run = [line]
    }
  }
  flush()
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
          const runs = maximalRuns(part.text)
          if (runs.length === 0) continue
          messages.push({ sessionId, kind: part.kind, chars: part.text.length, runs })
        }
      }
    }
  }
  writeFileSync(CACHE, JSON.stringify({ logs, messages }))
  console.log(`cached ${messages.length} messages with runs, from ${logs} logs → ${CACHE.pathname}`)
}

const cache = JSON.parse(readFileSync(CACHE, 'utf8'))
const messages = cache.messages

/**
 * A message that is one of the incidents this plugin exists for, not a false positive.
 *
 * Recognised by the shape rather than by a session id: a run whose lines are all the same
 * literal sentence repeated. That is precisely the thing the guard was built to stop, so a
 * corpus that contains it is a corpus with a true positive in it.
 */
function isKnownLoop(message) {
  return message.runs.some((run) => {
    const sample = run.sample.trim()
    if (sample.length === 0) return false
    const stripped = skeleton(sample).replace(/#/gu, '').trim()
    return run.lines >= 20 && stripped.length > 0 && run.chars / run.lines <= 40
  })
}

const real = messages.filter((m) => !isKnownLoop(m))
const loops = messages.filter((m) => isKnownLoop(m))
console.log(
  `\n语料：${messages.length} 条有连跑的消息 · 其中 ${loops.length} 条是已知的真循环（"Let me go." 那类），` +
    `${real.length} 条是正常输出`,
)

/** Heaviest run that would qualify under `(minLines, budget)`, or null. */
function qualifies(message, minLines, budget) {
  let best = null
  for (const run of message.runs) {
    if (run.lines < minLines || run.chars < budget) continue
    if (best === null || run.chars > best.chars) best = run
  }
  return best
}

const MIN_LINES = [3, 4, 5, 6, 8, 10, 12]
const BUDGETS = [80, 120, 160, 200, 240, 300, 400, 500, 600, 800]

console.log(`\n${'═'.repeat(96)}`)
console.log('★ 参数网格：每格 = 在这 97 万字真实输出里会误报的消息条数')
console.log('═'.repeat(96))
process.stdout.write(`${'minLines'.padEnd(10)}`)
for (const b of BUDGETS) process.stdout.write(`${String(b).padStart(8)}`)
console.log('')

const grid = {}
for (const minLines of MIN_LINES) {
  process.stdout.write(`${String(minLines).padEnd(10)}`)
  for (const budget of BUDGETS) {
    let hits = 0
    for (const message of real) if (qualifies(message, minLines, budget) !== null) hits += 1
    grid[`${minLines}/${budget}`] = hits
    process.stdout.write(`${(hits === 0 ? '✓0' : String(hits)).padStart(8)}`)
  }
  console.log('')
}

// ── what each surviving cell costs in latency on the loop shapes ───────────────────────────

const SHAPES = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
  '一 / 二 / 四 三行循环': (i) => ['一', '二', '四'][i % 3],
}

/** Feed line by line; report the line number at which the rule first fires. */
function latency(makeLine, minLines, budget) {
  const lines = []
  for (let i = 0; i < 400; i += 1) {
    lines.push(makeLine(i))
    const runs = maximalRuns(lines.join('\n'))
    for (const run of runs) if (run.lines >= minLines && run.chars >= budget) return { at: i + 1, run }
  }
  return null
}

console.log(`\n${'═'.repeat(96)}`)
console.log('★ 命中的几行（行数 / 累计字数）—— 同一格必须既零误报、又足够早')
console.log('═'.repeat(96))

const SURVIVORS = []
for (const minLines of MIN_LINES) {
  for (const budget of BUDGETS) {
    if (grid[`${minLines}/${budget}`] === 0) SURVIVORS.push({ minLines, budget })
  }
}
console.log(`零误报的格子共 ${SURVIVORS.length} 个\n`)

process.stdout.write(`${'形状'.padEnd(34)}`)
for (const cell of SURVIVORS) process.stdout.write(`${`${cell.minLines}行/${cell.budget}`.padStart(14)}`)
console.log('')

for (const [name, makeLine] of Object.entries(SHAPES)) {
  process.stdout.write(`${name.padEnd(34)}`)
  for (const cell of SURVIVORS) {
    const seen = latency(makeLine, cell.minLines, cell.budget)
    process.stdout.write(`${(seen === null ? '漏' : `${seen.at}行/${seen.run.chars}字`).padStart(14)}`)
  }
  console.log('')
}
