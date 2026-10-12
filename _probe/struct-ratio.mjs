/**
 * A scale-free statistic, and whether it separates the two populations any better.
 *
 * "Letters per line" mixes two things: how much text is on a line, and how much of that text is
 * a number. A CAD coordinate dump is 45 characters of which 8 are letters; a fake-progress loop
 * is 15 characters of which 10 are letters. Both statistics move together, which is why the
 * letters-per-line threshold had to sit at 8 and the CAD listing reached exactly 8.0.
 *
 * The ratio `letters / (letters + digits)` drops the line length out of it. A listing is mostly
 * numbers repeating a format, so its ratio is low however long the lines are; a loop is a
 * sentence with one fresh number glued on, so its ratio is high however short the lines are.
 *
 * This prints, for both statistics, the honest runs at each line count and the resulting grid,
 * so the choice between them is made on numbers rather than on which one sounds better.
 *
 *   node _probe/struct-ratio.mjs
 */

import { readFileSync } from 'node:fs'

const cache = JSON.parse(readFileSync(new URL('./struct-real-cache.json', import.meta.url), 'utf8'))

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

/** A message that contains a run we already know is a real incident, not honest output. */
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
const runs = [...distinct.values()].map((r) => ({
  ...r,
  lettersPerLine: r.letters / r.lines,
  ratio: r.letters + r.digits === 0 ? 0 : r.letters / (r.letters + r.digits),
}))

console.log('═'.repeat(112))
console.log('★ 每个行数门槛下，诚实形状里「字母占比」最高的那几个 —— 它们就是阈值的天花板')
console.log('═'.repeat(112))
console.log(
  `${'行数'.padStart(5)} ${'段数'.padStart(5)} ${'最高字母占比'.padStart(12)} ${'最高字母/行'.padStart(12)}  最接近的那一段`,
)
console.log('─'.repeat(112))
for (const L of [8, 10, 12, 14, 16, 20, 24, 30, 40]) {
  const pool = runs.filter((r) => r.lines >= L)
  if (pool.length === 0) {
    console.log(`${String(L).padStart(5)} ${String(0).padStart(5)} ${'—'.padStart(12)} ${'—'.padStart(12)}`)
    continue
  }
  const topRatio = pool.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  const topLetters = pool.reduce((a, b) => (b.lettersPerLine > a.lettersPerLine ? b : a))
  console.log(
    `${String(L).padStart(5)} ${String(pool.length).padStart(5)} ` +
      `${(topRatio.ratio * 100).toFixed(0).padStart(11)}% ${topLetters.lettersPerLine.toFixed(1).padStart(12)}  ` +
      `${topRatio.sample.trim().slice(0, 48)}`,
  )
}

// ── the two grids, side by side ────────────────────────────────────────────────────────────

const SHAPES = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
  '第 N 次尝试：连接数据库超时。': (i) => `第 ${i + 1} 次尝试：连接数据库超时。`,
  '第 N 项：检查完毕。': (i) => `第 ${i + 1} 项：检查完毕。`,
}

function stats(text) {
  const letters = (text.match(/\p{L}/gu) ?? []).length
  const digits = (text.match(/\d/gu) ?? []).length
  return { letters, digits, ratio: letters + digits === 0 ? 0 : letters / (letters + digits) }
}

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 网格 A：≥minLines 行 且 字母/行 ≥ minLetters')
console.log(`${'═'.repeat(112)}`)
const LINES = [12, 14, 16, 20, 24, 30]
for (const axis of [
  { name: '字母/行', of: (r) => r.lettersPerLine, values: [4, 6, 8, 10] },
  { name: '字母占比', of: (r) => r.ratio * 100, values: [30, 40, 50, 60, 70] },
]) {
  console.log(`\n  ${axis.name}：`)
  process.stdout.write(`  ${'minLines'.padEnd(10)}`)
  for (const v of axis.values) process.stdout.write(`${`≥${v}`.padStart(10)}`)
  console.log('')
  for (const L of LINES) {
    process.stdout.write(`  ${String(L).padEnd(10)}`)
    for (const v of axis.values) {
      const hit = runs.filter((r) => r.lines >= L && axis.of(r) >= v)
      process.stdout.write(`${(hit.length === 0 ? '✓0' : String(hit.length)).padStart(10)}`)
    }
    console.log('')
  }
}

console.log(`\n${'═'.repeat(112)}`)
console.log('★ 各格子对真循环的延迟（行/字）；「漏」= 那个形状达不到该格的字母要求')
console.log(`${'═'.repeat(112)}`)
const CELLS = [
  { L: 12, kind: 'ratio', v: 50 },
  { L: 12, kind: 'ratio', v: 60 },
  { L: 12, kind: 'ratio', v: 70 },
  { L: 14, kind: 'ratio', v: 60 },
]
process.stdout.write(`${'形状'.padEnd(30)}`)
for (const c of CELLS) process.stdout.write(`${`${c.L}行/${c.kind === 'letters' ? c.v + 'L' : c.v + '%'}`.padStart(14)}`)
console.log('')
for (const [name, make] of Object.entries(SHAPES)) {
  process.stdout.write(`${name.padEnd(30)}`)
  for (const cell of CELLS) {
    let found = null
    const lines = []
    for (let i = 0; i < 4000 && found === null; i += 1) {
      lines.push(make(i))
      if (lines.length < cell.L) continue
      const s = stats(lines.join('\n'))
      const ok =
        cell.kind === 'letters' ? s.letters / lines.length >= cell.v : s.ratio * 100 >= cell.v
      if (ok) found = { at: lines.length, chars: lines.join('\n').length }
    }
    process.stdout.write(`${(found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(14)}`)
  }
  console.log('')
}
