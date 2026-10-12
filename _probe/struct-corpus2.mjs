/**
 * The corrected corpus measurement.
 *
 * The first pass had a bug that made its own conclusion useless: it counted a run's weight as
 * the length of the whole line, so a single 15119-character minified line in `lib/client.js`
 * — one line, repeated zero times — was reported as the longest "run" in the repository. A
 * run of one is not a run. The number that matters is the weight of a run that is at least
 * `MIN_LINES` long, because that is the only kind the detector would ever look at.
 *
 * So this pass asks the question in the order the detector does:
 *
 *   1. find every contiguous run of >= MIN_LINES lines sharing one skeleton
 *   2. report its total character weight
 *   3. print the distribution's tail
 *
 * The budget the detector uses has to clear that tail. If the tail is short — a few hundred
 * characters — a counter loop is caught early and nothing else is disturbed. If ordinary
 * documents contain two-thousand-character runs, the detector cannot be shipped, because it
 * would fire on a table.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const MIN_LINES = 4
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '_原始归档', '.chrome-profile', 'shots', 'dist', 'build'])

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
 * Every run of >= MIN_LINES consecutive lines sharing one skeleton, with its weight.
 *
 * A blank line ends a run. Two identical paragraphs with a break between them are two
 * paragraphs; treating the gap as transparent would merge a whole document into one run.
 */
function runs(text) {
  const found = []
  let chars = 0
  let lines = 0
  let current = ''

  for (const raw of text.split('\n')) {
    if (isBlank(raw)) {
      chars = 0
      lines = 0
      current = ''
      continue
    }
    const key = skeleton(raw)
    const usable = hasContent(key) && key.length >= 4
    if (usable && key === current) {
      chars += raw.length
      lines += 1
    } else {
      chars = usable ? raw.length : 0
      lines = usable ? 1 : 0
      current = usable ? key : ''
    }
    if (lines >= MIN_LINES) found.push({ chars, lines, sample: raw, key: current })
  }
  return found
}

function walk(root, out = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(join(root, entry.name), out)
    } else if (['.md', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.txt', '.css'].includes(extname(entry.name))) {
      out.push(join(root, entry.name))
    }
  }
  return out
}

function scan(label, root) {
  const files = walk(root)
  const all = []
  let scanned = 0

  for (const file of files) {
    let text
    try {
      if (statSync(file).size > 2_000_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    scanned += 1
    for (const run of runs(text)) all.push({ ...run, file: file.slice(root.length + 1) })
  }

  all.sort((a, b) => b.chars - a.chars)
  const withRuns = new Set(all.map((r) => r.file)).size

  console.log(`\n${'═'.repeat(80)}`)
  console.log(`${label}`)
  console.log(`${scanned} 文件扫过 · ${withRuns} 文件出现过 ≥${MIN_LINES} 行的骨架连跑 · 共 ${all.length} 处`)
  console.log('═'.repeat(80))

  const buckets = { '≤300': 0, '300-600': 0, '600-1000': 0, '1000-1600': 0, '1600-2400': 0, '≥2400': 0 }
  for (const run of all) {
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
    const bar = '█'.repeat(Math.min(50, Math.round((count / Math.max(1, all.length)) * 50)))
    console.log(`  ${key.padEnd(12)} ${String(count).padStart(4)} 处  ${bar}`)
  }

  console.log(`\n  —— 最重的 10 处 ——`)
  for (const run of all.slice(0, 10)) {
    const sample = run.sample.length > 58 ? run.sample.slice(0, 57) + '…' : run.sample
    console.log(`  ${String(run.chars).padStart(5)} 字 / ${String(run.lines).padStart(3)} 行  ${sample}`)
    console.log(`  ${' '.repeat(16)}↳ ${run.file}`)
  }

  return { worst: all[0] ?? { chars: 0, lines: 0, sample: '', file: '' }, total: all.length }
}

const a = scan('语料 ①：dsh-loop-guard 仓库（源码 + 文档）', '<checkout>')
const b = scan('语料 ②：AI-ku 知识库（真实中文笔记）', '<notes>')

console.log(`\n${'═'.repeat(80)}`)
console.log('★ 真实语料里最重的骨架连跑')
console.log('═'.repeat(80))
console.log(`  仓库：  ${a.worst.chars} 字 / ${a.worst.lines} 行  ← ${a.worst.file}`)
console.log(`  知识库：${b.worst.chars} 字 / ${b.worst.lines} 行  ← ${b.worst.file}`)
const safe = Math.max(a.worst.chars, b.worst.chars)
console.log(`\n  ⇒ 预算 ≥ ${safe} 字 即可在这两份语料上零误报（当前上限 ${Math.max(a.worst.lines, b.worst.lines)} 行）`)
