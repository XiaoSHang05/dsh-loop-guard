/**
 * The decisive test: run the skeleton scanner over real files, and see how far it ever gets.
 *
 * The synthetic negatives in struct-hard.mjs were written by the same hand that wrote the
 * loops, which makes them a weak control — I knew what the detector looked for, so I could
 * have unconsciously written either an easy or an impossible set. Real corpora have no such
 * bias: nobody wrote them to be scanned by this.
 *
 * Two corpora, chosen because they are the two failure surfaces that matter:
 *
 *   the repository itself   — source, prose, tables; English-heavy, code-heavy
 *   the AI-ku knowledge base — 800+ markdown files of real Chinese notes, with the tables,
 *                              checklists and numbered lists that this detector is most
 *                              likely to mistake for a counter
 *
 * A third of the knowledge base is the point: if a 2400-character skeleton run occurs in
 * ordinary Chinese notes, the detector is not conservative enough to ship.
 *
 * WHAT THIS MEASURES
 * The maximum skeleton run found in each file, in characters and in lines. The output is a
 * histogram plus the worst offenders, so the question "what budget is safe" is answered by
 * data rather than by choosing the number that makes the loops look good.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

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
 * Longest contiguous skeleton run in the whole file.
 *
 * A blank line ENDS a run. Two identical paragraphs with a paragraph break between them are
 * two paragraphs; treating the gap as transparent would merge every section of a document
 * into one apparent run, which is how a detector ends up firing on a table of contents.
 */
function longestRun(text) {
  let best = { chars: 0, lines: 0, sample: '' }
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
    if (chars > best.chars) best = { chars, lines, sample: raw }
  }
  return best
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

function scanCorpus(label, root) {
  const files = walk(root)
  const buckets = { '<200': 0, '200-400': 0, '400-800': 0, '800-1600': 0, '1600-2400': 0, '2400-4000': 0, '≥4000': 0 }
  const worst = []
  let bytes = 0

  for (const file of files) {
    let text
    try {
      const stat = statSync(file)
      if (stat.size > 2_000_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    bytes += text.length
    const run = longestRun(text)
    const key =
      run.chars < 200 ? '<200'
      : run.chars < 400 ? '200-400'
      : run.chars < 800 ? '400-800'
      : run.chars < 1600 ? '800-1600'
      : run.chars < 2400 ? '1600-2400'
      : run.chars < 4000 ? '2400-4000'
      : '≥4000'
    buckets[key] += 1
    worst.push({ file: file.slice(root.length + 1), chars: run.chars, lines: run.lines, sample: run.sample })
  }

  worst.sort((a, b) => b.chars - a.chars)

  console.log(`\n${'═'.repeat(78)}`)
  console.log(`${label}`)
  console.log(`${files.length} 个文件 / ${(bytes / 1024).toFixed(0)} KB 文本`)
  console.log('═'.repeat(78))
  for (const [key, count] of Object.entries(buckets)) {
    const bar = '█'.repeat(Math.min(60, Math.round((count / Math.max(1, files.length)) * 60)))
    console.log(`  ${key.padEnd(12)} ${String(count).padStart(5)} 文件  ${bar}`)
  }
  console.log('\n  —— 最长的 8 个骨架连跑 ——')
  for (const item of worst.slice(0, 8)) {
    const sample = item.sample.length > 62 ? item.sample.slice(0, 61) + '…' : item.sample
    console.log(`  ${String(item.chars).padStart(6)} 字 / ${String(item.lines).padStart(3)} 行  ${sample}`)
    console.log(`  ${' '.repeat(18)}↳ ${item.file}`)
  }
  return { files: files.length, worst: worst[0] }
}

const repo = '<checkout>'
const ku = '<notes>'

const a = scanCorpus('语料 ①：dsh-loop-guard 仓库本身（源码 + 文档 + 表格）', repo)
const b = scanCorpus('语料 ②：AI-ku 知识库（800+ 真实中文笔记）', ku)

console.log(`\n${'═'.repeat(78)}`)
console.log('★ 结论')
console.log('═'.repeat(78))
console.log(`  仓库最长骨架连跑：   ${a.worst.chars} 字 / ${a.worst.lines} 行`)
console.log(`  知识库最长骨架连跑： ${b.worst.chars} 字 / ${b.worst.lines} 行`)
const safe = Math.max(a.worst.chars, b.worst.chars)
console.log(`\n  ⇒ 真实语料里出现的最大骨架连跑 = ${safe} 字`)
console.log(`  ⇒ 预算取 ${safe} 以上，在这两份语料上零误报。`)
