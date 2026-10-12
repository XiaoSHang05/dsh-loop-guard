/**
 * The same corpus, with duplicates removed.
 *
 * The previous numbers were counting *messages*, and one CAD coordinate listing appears in many
 * messages — so "276 false positives at a 500-character budget" was really "one listing, seen
 * 276 times". A threshold tuned against that number is tuned against an artefact of how the
 * corpus was collected, not against how the detector will behave.
 *
 * Runs are therefore deduplicated by their text. What survives is the set of *distinct shapes*
 * this machine has actually produced, which is the only population a threshold can be argued
 * from. The report also separates the two things a threshold can act on:
 *
 *   - how many lines a run spans (a numbered list of 12 ports is honest; a loop is unbounded)
 *   - what the run is made of (a coordinate listing is mostly digits; a fake-progress loop is
 *     a sentence with a fresh number glued on)
 *
 *   node _probe/struct-distinct.mjs
 */

import { readFileSync } from 'node:fs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

function isKnownLoop(message) {
  return message.runs.some((run) => {
    const sample = run.sample.trim()
    if (sample.length === 0) return false
    const stripped = skeleton(sample).replace(/#/gu, '').trim()
    return run.lines >= 20 && stripped.length > 0 && run.chars / run.lines <= 40
  })
}

const real = cache.messages.filter((m) => !isKnownLoop(m))
const loops = cache.messages.filter((m) => isKnownLoop(m))

/** Distinct runs, keyed by text when we kept it, otherwise by shape+sample. */
const distinct = new Map()
let total = 0
for (const message of real) {
  for (const run of message.runs) {
    total += 1
    const key = run.text ?? `${run.lines}|${run.chars}|${run.sample}`
    const seen = distinct.get(key)
    if (seen === undefined) {
      distinct.set(key, { ...run, messages: 1 })
    } else {
      seen.messages += 1
    }
  }
}

const runs = [...distinct.values()]
console.log(`${'═'.repeat(112)}`)
console.log('★ 去重前后')
console.log(`${'═'.repeat(112)}`)
console.log(`正常消息 ${real.length} 条 · 其中的连跑 ${total} 段（含重复）· 去重后 ${runs.length} 段`)
console.log(`已知真循环消息 ${loops.length} 条`)
console.log(`重复系数 ${(total / runs.length).toFixed(1)}× —— 上一轮「误报 N 条」里有一大半是同一段被数了很多次`)

// ── how heavy does an honest run actually get? ─────────────────────────────────────────────

const byChars = [...runs].sort((a, b) => b.chars - a.chars)
const byLines = [...runs].sort((a, b) => b.lines - a.lines)

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 最重的 16 段（去重后，按字数）')
console.log(`${'═'.repeat(112)}`)
console.log(
  `${'字数'.padStart(6)} ${'行数'.padStart(4)} ${'字/行'.padStart(6)} ${'数字%'.padStart(6)} ${'字母/行'.padStart(7)} ${'出现'.padStart(4)}  样本`,
)
console.log('─'.repeat(112))
for (const run of byChars.slice(0, 16)) {
  console.log(
    `${String(run.chars).padStart(6)} ${String(run.lines).padStart(4)} ` +
      `${(run.chars / run.lines).toFixed(1).padStart(6)} ` +
      `${((run.digits / run.chars) * 100).toFixed(0).padStart(5)}% ` +
      `${(run.letters / run.lines).toFixed(1).padStart(7)} ${String(run.messages).padStart(4)}  ` +
      `${run.sample.slice(0, 52)}`,
  )
}

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 最长的 16 段（去重后，按行数）—— 行数才是「像列表还是像循环」的杠杆')
console.log(`${'═'.repeat(112)}`)
console.log(
  `${'行数'.padStart(4)} ${'字数'.padStart(6)} ${'字/行'.padStart(6)} ${'数字%'.padStart(6)} ${'字母/行'.padStart(7)} ${'出现'.padStart(4)}  样本`,
)
console.log('─'.repeat(112))
for (const run of byLines.slice(0, 16)) {
  console.log(
    `${String(run.lines).padStart(4)} ${String(run.chars).padStart(6)} ` +
      `${(run.chars / run.lines).toFixed(1).padStart(6)} ` +
      `${((run.digits / run.chars) * 100).toFixed(0).padStart(5)}% ` +
      `${(run.letters / run.lines).toFixed(1).padStart(7)} ${String(run.messages).padStart(4)}  ` +
      `${run.sample.slice(0, 52)}`,
  )
}

// ── the two ceilings that matter ───────────────────────────────────────────────────────────

const maxLines = byLines[0].lines
const maxChars = byChars[0].chars
const maxLettersPerLine = Math.max(...runs.map((r) => r.letters / r.lines))
const heavyRuns = runs.filter((r) => r.chars >= 200)

console.log(`\n${'─'.repeat(112)}`)
console.log(`★ 诚实输出的三个上限（去重后）`)
console.log(`   行数上限   ${maxLines} 行`)
console.log(`   字数上限   ${maxChars} 字`)
console.log(`   字母/行上限 ${maxLettersPerLine.toFixed(1)}`)

const LOOP_LETTERS = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
}
console.log(`\n   真循环的「字母/行」：`)
for (const [name, make] of Object.entries(LOOP_LETTERS)) {
  const line = make(0)
  const letters = (line.match(/\p{L}/gu) ?? []).length
  console.log(`     ${letters.toFixed(1).padStart(5)}  ${name}`)
}

// ── the grid, on distinct runs ─────────────────────────────────────────────────────────────

const MIN_LINES = [4, 6, 8, 10, 12, 16, 20]
const BUDGETS = [200, 300, 400, 500, 600, 800, 1200]

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 参数网格（去重后）：每格 = 会误伤的**不同形状**数')
console.log('   规则 = 连跑 ≥minLines 行 且 ≥budget 字')
console.log(`${'═'.repeat(112)}`)
process.stdout.write(`${'minLines'.padEnd(10)}`)
for (const b of BUDGETS) process.stdout.write(`${String(b).padStart(9)}`)
console.log('')
const grid = {}
for (const minLines of MIN_LINES) {
  process.stdout.write(`${String(minLines).padEnd(10)}`)
  for (const budget of BUDGETS) {
    const hit = runs.filter((r) => r.lines >= minLines && r.chars >= budget)
    grid[`${minLines}/${budget}`] = hit
    process.stdout.write(`${(hit.length === 0 ? '✓0' : String(hit.length)).padStart(9)}`)
  }
  console.log('')
}

const clean = []
for (const minLines of MIN_LINES) {
  for (const budget of BUDGETS) {
    if (grid[`${minLines}/${budget}`].length === 0) clean.push({ minLines, budget })
  }
}
console.log(`\n零误伤的格子共 ${clean.length} 个：${clean.map((c) => `${c.minLines}行/${c.budget}字`).join(' · ') || '（一个都没有）'}`)

// ── what a surviving cell costs on the loop shapes ─────────────────────────────────────────

if (clean.length > 0) {
  console.log(`\n${'═'.repeat(112)}`)
  console.log('★ 掐断时机（行数 / 累计字数）')
  console.log(`${'═'.repeat(112)}`)
  const shown = clean.slice(0, 10)
  process.stdout.write(`${'形状'.padEnd(34)}`)
  for (const cell of shown) process.stdout.write(`${`${cell.minLines}行/${cell.budget}`.padStart(13)}`)
  console.log('')
  for (const [name, make] of Object.entries(LOOP_LETTERS)) {
    process.stdout.write(`${name.padEnd(34)}`)
    for (const cell of shown) {
      let found = null
      for (let i = 0; i < 5000 && found === null; i += 1) {
        const lines = []
        for (let k = 0; k <= i; k += 1) lines.push(make(k))
        if (i + 1 >= cell.minLines && lines.join('\n').length >= cell.budget) {
          found = { at: i + 1, chars: lines.join('\n').length }
        }
      }
      process.stdout.write(`${(found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(13)}`)
    }
    console.log('')
  }
}
