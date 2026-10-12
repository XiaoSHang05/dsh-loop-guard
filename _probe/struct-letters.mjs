/**
 * The statistic that separates a counter loop from an honest listing.
 *
 * `struct-sweep.mjs` found a cliff: a 600-character budget fires on nothing in 32,117 ordinary
 * messages, a 500-character budget fires on 276 of them, and the heaviest honest run in the
 * whole corpus is 543 characters. A threshold sitting 10% above the tallest thing one machine
 * happened to write is not a threshold — it is a coincidence, and it breaks on the next machine.
 *
 * So the budget cannot be the whole rule. What is the heaviest honest run? A CAD coordinate
 * listing:
 *
 *     1. `L 2 (3940712.246,1758068.18)→(3941100.864,1758068.18)`
 *
 * Nine of those, 538 characters, and every line reduces to the same skeleton — because the
 * *format* is identical. That is exactly what a fake-progress loop does too:
 *
 *     第 1 步：读取配置文件完成。
 *     第 2 步：读取配置文件完成。
 *
 * Both repeat a skeleton; line count and character weight cannot tell them apart, which is why
 * every threshold on those two axes either fires on coordinates or waits until the loop has
 * already done its damage.
 *
 * The difference is *what is left when the digits are gone*. A listing is mostly numbers
 * repeating a format — strip the digits and almost nothing remains. A loop is a sentence with a
 * fresh number glued on — strip the digits and a whole sentence remains, identical every line.
 *
 * So the rule this measures is: a run qualifies when it is heavy enough AND its non-digit
 * remainder carries enough text per line to be a sentence rather than a delimiter.
 *
 *   node _probe/struct-letters.mjs
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

/** Letters per line: the size of the part that survives digit-stripping. */
const perLine = (run) => run.letters / run.lines

const heavy = []
for (const message of real) {
  for (const run of message.runs) {
    if (run.chars >= 300) heavy.push({ ...run, sessionId: message.sessionId, kind: message.kind })
  }
}
heavy.sort((a, b) => b.chars - a.chars)

console.log(`${'═'.repeat(110)}`)
console.log('★ 真实语料里最重的 24 段同骨架连跑（≥300 字）—— 按字数排序')
console.log(`${'═'.repeat(110)}`)
console.log(
  `${'字数'.padStart(6)} ${'行数'.padStart(4)} ${'字/行'.padStart(6)} ${'数字%'.padStart(6)} ${'字母/行'.padStart(7)}  样本`,
)
console.log('─'.repeat(110))
for (const run of heavy.slice(0, 24)) {
  console.log(
    `${String(run.chars).padStart(6)} ${String(run.lines).padStart(4)} ` +
      `${(run.chars / run.lines).toFixed(1).padStart(6)} ` +
      `${((run.digits / run.chars) * 100).toFixed(0).padStart(5)}% ` +
      `${perLine(run).toFixed(1).padStart(7)}  ${run.sample.slice(0, 58)}`,
  )
}

// ── the separation question ────────────────────────────────────────────────────────────────

const CEILING = Math.max(...heavy.map(perLine))
const heaviest = heavy[0]
console.log(`\n${'─'.repeat(110)}`)
console.log(`真实连跑里「字母/行」的最高值 = ${CEILING.toFixed(2)}  （出现在 ${heaviest.chars} 字 / ${heaviest.lines} 行的连跑上）`)
console.log('全部连跑的字数上限 = ' + Math.max(...heavy.map((r) => r.chars)))

const SHAPES = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
  'Let me go.（真事故）': () => 'Let me go. ',
}

const stat = (line) => ({
  letters: (line.match(/\p{L}/gu) ?? []).length,
  digits: (line.match(/\d/gu) ?? []).length,
  chars: line.length,
})

console.log(`\n${'─'.repeat(110)}`)
console.log('对照：真循环的同一组统计（每行都算，取平均）')
console.log('─'.repeat(110))
console.log(`${'形状'.padEnd(34)} ${'字/行'.padStart(6)} ${'数字%'.padStart(6)} ${'字母/行'.padStart(7)}`)
let loopFloor = Infinity
for (const [name, make] of Object.entries(SHAPES)) {
  const s = stat(make(0))
  const letters = s.letters
  loopFloor = Math.min(loopFloor, letters)
  console.log(
    `${name.padEnd(34)} ${s.chars.toFixed(1).padStart(6)} ` +
      `${((s.digits / s.chars) * 100).toFixed(0).padStart(5)}% ${letters.toFixed(1).padStart(7)}`,
  )
}
console.log(`\n真循环的「字母/行」最低值 = ${loopFloor}`)

// ── the sweep: does a letters-per-line floor remove the false positives? ───────────────────

const MIN_LINES = [3, 4, 5, 6, 8]
const BUDGETS = [200, 300, 400, 500, 600]
const LETTERS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12]

console.log(`\n${'═'.repeat(110)}`)
console.log('★ 三维网格：每格 = 在真实语料里误报的消息条数')
console.log('   规则 = 连跑 ≥minLines 行 且 ≥budget 字 且 字母数 ≥letters×行数')
console.log(`${'═'.repeat(110)}`)

const results = []
for (const budget of BUDGETS) {
  for (const minLetters of LETTERS) {
    let hits = 0
    let worst = null
    for (const message of real) {
      for (const run of message.runs) {
        if (run.lines < 3 || run.chars < budget) continue
        if (run.letters < minLetters * run.lines) continue
        hits += 1
        if (worst === null || run.chars > worst.chars) worst = run
      }
    }
    results.push({ budget, minLetters, hits, worst })
  }
}

process.stdout.write(`${'budget'.padStart(8)}`)
for (const minLetters of LETTERS) process.stdout.write(`${`字母≥${minLetters}/行`.padStart(12)}`)
console.log('')
for (const budget of BUDGETS) {
  process.stdout.write(`${String(budget).padStart(8)}`)
  for (const minLetters of LETTERS) {
    const cell = results.find((r) => r.budget === budget && r.minLetters === minLetters)
    process.stdout.write(`${(cell.hits === 0 ? '✓0' : String(cell.hits)).padStart(12)}`)
  }
  console.log('')
}

const clean = results.filter((r) => r.hits === 0)
console.log(`\n零误报的格子共 ${clean.length} 个：`)
for (const cell of clean) {
  console.log(`  budget=${cell.budget}  字母≥${cell.minLetters}/行`)
}

// ── what each clean cell costs on the loops ────────────────────────────────────────────────

if (clean.length > 0) {
  const shown = clean.slice(0, 12)
  console.log(`\n${'═'.repeat(110)}`)
  console.log('★ 这些格子要等多久才掐断（行数 / 累计字数）')
  console.log(`${'═'.repeat(110)}`)
  process.stdout.write(`${'形状'.padEnd(34)}`)
  for (const cell of shown) process.stdout.write(`${`${cell.budget}/${cell.minLetters}L`.padStart(13)}`)
  console.log('')

  for (const [name, make] of Object.entries(SHAPES)) {
    process.stdout.write(`${name.padEnd(34)}`)
    for (const cell of shown) {
      let found = null
      for (let i = 0; i < 4000 && found === null; i += 1) {
        const lines = []
        for (let k = 0; k <= i; k += 1) lines.push(make(k))
        const joined = lines.join('\n')
        const chars = joined.length
        if (chars < cell.budget) continue
        const letters = (joined.match(/\p{L}/gu) ?? []).length
        if (letters >= cell.minLetters * lines.length) found = { at: i + 1, chars }
      }
      process.stdout.write(`${(found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(13)}`)
    }
    console.log('')
  }
}
