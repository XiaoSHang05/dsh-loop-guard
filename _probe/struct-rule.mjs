/**
 * The rule the corpus actually supports.
 *
 * Two thresholds have been tried and both were wrong for the same reason: they measured the
 * wrong thing.
 *
 *   Line count alone — a loop and a 12-port listing are both "12 lines".
 *   Character budget alone — the heaviest honest run in 32,117 messages is a CAD coordinate
 *     listing, 543 characters. A 600-character budget is clean only because nothing on this
 *     machine ever got heavier; it is 10% of margin standing in for a principle.
 *
 * What the corpus shows is that the two populations differ in *what each line is made of*:
 *
 *   honest heavy runs   the coordinate dumps   0–8 letters per line   (68–77% digits)
 *   loops               sentences + a number   8–21 letters per line  (4–21% digits)
 *
 * A coordinate listing is mostly numbers repeating a format. A fake-progress loop is a whole
 * sentence repeating with a fresh number glued on. So the rule worth testing is not "how much
 * text has streamed" but "how much *sentence* is on each line" — letters per line — plus enough
 * lines that the repetition is a loop rather than a table row that happens to share a format.
 *
 * This sweeps that grid and reports, for every cell that survives, the worst honest run that
 * got closest to it. A cell with no margin is not a cell worth shipping.
 *
 *   node _probe/struct-rule.mjs
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

const distinct = new Map()
for (const message of real) {
  for (const run of message.runs) {
    const key = run.text ?? `${run.lines}|${run.chars}|${run.sample}`
    if (!distinct.has(key)) distinct.set(key, run)
  }
}
const runs = [...distinct.values()].map((r) => ({ ...r, lettersPerLine: r.letters / r.lines }))

const LINES = [4, 5, 6, 8, 10, 12]
const LETTERS = [0, 2, 4, 6, 8, 10, 12]

console.log(`${'═'.repeat(112)}`)
console.log('★ 规则 = 同骨架连跑 ≥minLines 行 且 每行 ≥minLetters 个字母（不设字数预算）')
console.log('   每格 = 在 1,329 种不同的诚实形状里会误伤几种')
console.log(`${'═'.repeat(112)}`)
process.stdout.write(`${'minLines'.padEnd(10)}`)
for (const l of LETTERS) process.stdout.write(`${`≥${l}字母/行`.padStart(11)}`)
console.log('')

const cells = []
for (const minLines of LINES) {
  process.stdout.write(`${String(minLines).padEnd(10)}`)
  for (const minLetters of LETTERS) {
    const hit = runs.filter((r) => r.lines >= minLines && r.lettersPerLine >= minLetters)
    cells.push({ minLines, minLetters, hit })
    process.stdout.write(`${(hit.length === 0 ? '✓0' : String(hit.length)).padStart(11)}`)
  }
  console.log('')
}

// ── margin: what honest run sits closest to each surviving cell ────────────────────────────

const clean = cells.filter((c) => c.hit.length === 0)
console.log(`\n零误伤的格子共 ${clean.length} 个`)

/**
 * How much room a cell leaves.
 *
 * "No false positive" is a statement about one corpus. The useful question is how far the
 * nearest honest shape is from the line, because that distance is what survives a different
 * machine with different work on it. A cell whose margin is one line is a cell that will fire
 * on somebody else's table.
 */
function margin(cell) {
  // Closest honest run by line count, among runs that would fire if they had one more line.
  const near = runs
    .filter((r) => r.lettersPerLine >= cell.minLetters && r.lines < cell.minLines)
    .sort((a, b) => b.lines - a.lines)[0]
  // Closest honest run by letters, among runs long enough to fire.
  const nearLetters = runs
    .filter((r) => r.lines >= cell.minLines && r.lettersPerLine < cell.minLetters)
    .sort((a, b) => b.lettersPerLine - a.lettersPerLine)[0]
  return { near, nearLetters }
}

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 每个零误伤格子的余量 —— 最近的诚实形状离触发线还有多远')
console.log(`${'═'.repeat(112)}`)
console.log(`${'格子'.padEnd(18)} ${'行数余量'.padStart(22)} ${'字母余量'.padStart(26)}`)
console.log('─'.repeat(112))
for (const cell of clean) {
  const m = margin(cell)
  const lineMargin =
    m.near === undefined
      ? '（无同字母级的形状）'
      : `${cell.minLines - m.near.lines} 行（最近 ${m.near.lines} 行 / ${m.near.lettersPerLine.toFixed(1)} 字母）`
  const letterMargin =
    m.nearLetters === undefined
      ? '（无够长的形状）'
      : `${(cell.minLetters - m.nearLetters.lettersPerLine).toFixed(1)}（最近 ${m.nearLetters.lettersPerLine.toFixed(1)} 字母 / ${m.nearLetters.lines} 行）`
  console.log(`${`${cell.minLines}行/≥${cell.minLetters}字母`.padEnd(18)} ${lineMargin.padStart(22)} ${letterMargin.padStart(26)}`)
}

// ── what the surviving cells cost on the loop shapes ───────────────────────────────────────

const SHAPES = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
}

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 掐断时机（第几行 / 累计多少字）')
console.log(`${'═'.repeat(112)}`)
const shown = clean.slice(0, 12)
process.stdout.write(`${'形状'.padEnd(34)}`)
for (const cell of shown) process.stdout.write(`${`${cell.minLines}行/${cell.minLetters}L`.padStart(13)}`)
console.log('')
for (const [name, make] of Object.entries(SHAPES)) {
  process.stdout.write(`${name.padEnd(34)}`)
  for (const cell of shown) {
    let found = null
    for (let i = 0; i < 5000 && found === null; i += 1) {
      const line = make(i)
      const letters = (line.match(/\p{L}/gu) ?? []).length
      if (i + 1 >= cell.minLines && letters >= cell.minLetters) {
        const chars = []
        for (let k = 0; k <= i; k += 1) chars.push(make(k))
        found = { at: i + 1, chars: chars.join('\n').length }
      }
    }
    process.stdout.write(`${(found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(13)}`)
  }
  console.log('')
}
