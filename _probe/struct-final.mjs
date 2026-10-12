/**
 * The combined rule, and the margin it actually has.
 *
 * Three single thresholds were tried and all three were the wrong shape of answer:
 *
 *   line count alone      a loop and a 12-port listing are both "12 lines"
 *   character budget alone the heaviest honest run here is 543 chars, so a 600-char budget is
 *                          10% of margin standing in for a principle
 *   letters per line alone the honest CAD listing reaches 8.0 and the loop "Let me go." sits at
 *                          7.0 — the two populations overlap, so no single letter threshold works
 *
 * Overlap does not mean "give up"; it means one threshold cannot carry the decision. This sweeps
 * the combination — enough lines AND enough sentence per line — and reports, for every cell that
 * survives, the two numbers that decide whether it is worth shipping:
 *
 *   margin   how far the nearest honest shape sits from the line (in lines and in letters)
 *   latency  how many lines / characters a real counter loop streams before it fires
 *
 * A cell with no margin is a cell that fires on somebody else's table. A cell that fires late is
 * a cell that let the runaway print. The useful cells are the ones with room on both sides, and
 * the point of printing the margin is that "zero false positives on one corpus" is not a result —
 * it is a coincidence waiting for a different machine.
 *
 *   node _probe/struct-final.mjs
 */

import { readFileSync } from 'node:fs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

/** Messages that contain a run we already know is a real incident rather than honest output. */
function isKnownLoop(message) {
  return message.runs.some((run) => {
    const sample = run.sample.trim()
    if (sample.length === 0) return false
    const stripped = skeleton(sample).replace(/#/gu, '').trim()
    return run.lines >= 20 && stripped.length > 0 && run.chars / run.lines <= 40
  })
}

const real = cache.messages.filter((m) => !isKnownLoop(m))

/** One entry per distinct honest shape: the cache dedupes by the run's own sample. */
const distinct = new Map()
for (const message of real) {
  for (const run of message.runs) {
    const key = run.text ?? `${run.lines}|${run.chars}|${run.sample}`
    if (!distinct.has(key)) distinct.set(key, run)
  }
}
const runs = [...distinct.values()].map((r) => ({
  ...r,
  lettersPerLine: r.letters / r.lines,
  digitShare: r.chars === 0 ? 0 : r.digits / r.chars,
}))

// ── the grid ───────────────────────────────────────────────────────────────────────────────

const LINES = [6, 8, 10, 12, 14, 16, 20, 24, 30]
const LETTERS = [2, 4, 6, 8, 10, 12]

const SHAPES = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
}

function latency(make, cell) {
  let chars = 0
  for (let i = 0; i < 5000; i += 1) {
    const line = make(i)
    chars += line.length + 1
    const letters = (line.match(/\p{L}/gu) ?? []).length
    if (i + 1 >= cell.minLines && letters >= cell.minLetters) return { at: i + 1, chars }
  }
  return null
}

console.log(`${'═'.repeat(118)}`)
console.log('★ 规则 = 同骨架连跑 ≥minLines 行 且 每行 ≥minLetters 个字母')
console.log(`   1,329 种不同的诚实形状里会误伤几种；✓ 后括号里是最靠近触发线的那种诚实形状`)
console.log(`${'═'.repeat(118)}`)
process.stdout.write(`${'minLines'.padEnd(10)}`)
for (const l of LETTERS) process.stdout.write(`${`≥${l}字母/行`.padStart(17)}`)
console.log('')

const cells = []
for (const minLines of LINES) {
  process.stdout.write(`${String(minLines).padEnd(10)}`)
  for (const minLetters of LETTERS) {
    const hit = runs.filter((r) => r.lines >= minLines && r.lettersPerLine >= minLetters)
    cells.push({ minLines, minLetters, hit })
    process.stdout.write(`${(hit.length === 0 ? '✓0' : String(hit.length)).padStart(17)}`)
  }
  console.log('')
}

// ── margin ─────────────────────────────────────────────────────────────────────────────────

/**
 * How much room a cell leaves on each of its two axes.
 *
 * Both matter and neither is sufficient. A cell can be clean because no honest run is long
 * enough, or because none has enough letters per line; the honest reading of "margin" is the
 * smaller of the two, because that is the one a different corpus will close first.
 */
function margin(cell) {
  const nearLines = runs
    .filter((r) => r.lettersPerLine >= cell.minLetters && r.lines < cell.minLines)
    .sort((a, b) => b.lines - a.lines)[0]
  const nearLetters = runs
    .filter((r) => r.lines >= cell.minLines && r.lettersPerLine < cell.minLetters)
    .sort((a, b) => b.lettersPerLine - a.lettersPerLine)[0]
  return {
    lineGap: nearLines === undefined ? Infinity : cell.minLines - nearLines.lines,
    letterGap: nearLetters === undefined ? Infinity : cell.minLetters - nearLetters.lettersPerLine,
    nearLines,
    nearLetters,
  }
}

const clean = cells
  .filter((c) => c.hit.length === 0)
  .map((c) => ({ ...c, m: margin(c) }))
  .sort((a, b) => Math.min(b.m.lineGap, b.m.letterGap) - Math.min(a.m.lineGap, a.m.letterGap))

console.log(`\n${'═'.repeat(118)}`)
console.log('★ 零误伤的格子，按「最小余量」从大到小排 —— 余量小的格子换个语料就会响')
console.log(`${'═'.repeat(118)}`)
console.log(
  `${'格子'.padEnd(20)}${'行数余量'.padStart(12)}${'字母余量'.padStart(12)}   最近的行数侧诚实形状`,
)
console.log('─'.repeat(118))
for (const cell of clean) {
  const nl = cell.m.nearLines
  const desc =
    nl === undefined
      ? '（无同字母级的形状）'
      : `${nl.lines} 行 / ${nl.lettersPerLine.toFixed(1)} 字母 / ${nl.sample.trim().slice(0, 44)}`
  console.log(
    `${`${cell.minLines}行/≥${cell.minLetters}字母`.padEnd(20)}` +
      `${(cell.m.lineGap === Infinity ? '∞' : cell.m.lineGap).toString().padStart(12)}` +
      `${(cell.m.letterGap === Infinity ? '∞' : cell.m.letterGap.toFixed(1)).padStart(12)}   ${desc}`,
  )
}

// ── latency on the shapes we are here to catch ─────────────────────────────────────────────

console.log(`\n${'═'.repeat(118)}`)
console.log('★ 代价：真计数器循环要流出多少才响（对照：现在完全不响，实测 6692–9492 字）')
console.log(`${'═'.repeat(118)}`)

const shown = clean.filter((c) => Math.min(c.m.lineGap, c.m.letterGap) >= 2).slice(0, 8)
process.stdout.write(`${'形状'.padEnd(34)}`)
for (const cell of shown) process.stdout.write(`${`${cell.minLines}行/${cell.minLetters}L`.padStart(13)}`)
console.log('')
for (const [name, make] of Object.entries(SHAPES)) {
  process.stdout.write(`${name.padEnd(34)}`)
  for (const cell of shown) {
    const found = latency(make, cell)
    process.stdout.write(`${(found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(13)}`)
  }
  console.log('')
}

// ── the honest shape that shares the shape, stated plainly ─────────────────────────────────

console.log(`\n${'═'.repeat(118)}`)
console.log('★ 必须承认的一件事：这个形状和「合法枚举」在局部完全一样')
console.log(`${'═'.repeat(118)}`)
const twin = runs
  .filter((r) => r.lettersPerLine >= 6)
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 6)
for (const r of twin) {
  console.log(
    `${String(r.lines).padStart(3)} 行 ${String(r.chars).padStart(4)} 字 ` +
      `${r.lettersPerLine.toFixed(1).padStart(5)} 字母/行 ${(r.digitShare * 100).toFixed(0).padStart(3)}% 数字  ${r.sample.trim().slice(0, 62)}`,
  )
}
console.log(
  '\n⇒ 一个 9 项的合法清单和一个 9 行的计数器循环，在这台机器上留下的形状一模一样。\n' +
    '   区别不在局部，在「它会不会自己停」。所以阈值必须留出余量，而不是卡在最近的诚实形状上。',
)
