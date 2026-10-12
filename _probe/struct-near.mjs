/**
 * The honest shapes sitting closest to the firing line.
 *
 * `struct-rule.mjs` found cells with zero false positives. Zero on one corpus is not a
 * principle — the coordinate listing was also "zero" at a 600-character budget, and that turned
 * out to be 10% of luck. What separates a rule from a coincidence is the *margin*: how close an
 * honest shape came to firing, and whether that near-miss looks like the thing being hunted.
 *
 * A near-miss that is a sentence repeated with a fresh number glued on is not a near-miss — it
 * is a true positive the threshold happened to spare. A near-miss that is a data table would
 * fire on somebody else's machine the moment their table grew one row.
 *
 * So this prints them. Every honest run that a candidate rule almost fired on, in full, so the
 * decision is made by reading shapes rather than by reading a count.
 *
 *   node _probe/struct-near.mjs          # near-misses for the default candidate
 *   node _probe/struct-near.mjs 8 6      # runs with >=8 lines and >=6 letters/line
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
    const seen = distinct.get(key)
    if (seen === undefined) distinct.set(key, { ...run, messages: 1 })
    else seen.messages += 1
  }
}
const runs = [...distinct.values()].map((r) => ({ ...r, lpl: r.letters / r.lines }))

const minLines = Number(process.argv[2] ?? 6)
const minLetters = Number(process.argv[3] ?? 6)

const near = runs
  .filter((r) => r.lines >= minLines && r.lpl >= minLetters)
  .sort((a, b) => b.lpl - a.lpl)

console.log(`${'═'.repeat(112)}`)
console.log(`★ 诚实连跑里「≥${minLines} 行 且 ≥${minLetters} 字母/行」的全部 ${near.length} 段`)
console.log('   这些就是字母规则会吃掉的东西。逐段读，判断它是「句子里换个数字」还是「数据表格」。')
console.log(`${'═'.repeat(112)}`)

for (const run of near) {
  console.log(`\n${'─'.repeat(112)}`)
  console.log(
    `${run.lines} 行 · ${run.chars} 字 · ${run.lpl.toFixed(1)} 字母/行 · ${((run.digits / run.chars) * 100).toFixed(0)}% 数字` +
      ` · 在 ${run.messages} 条消息里出现`,
  )
  if (run.text === undefined) {
    console.log(`  （缓存未留全文，首行）${run.sample.slice(0, 96)}`)
    continue
  }
  const lines = run.text.split('\n')
  const shown = lines.length <= 12 ? lines : [...lines.slice(0, 6), `  … 共 ${lines.length} 行 …`, ...lines.slice(-3)]
  for (const line of shown) console.log(`  │ ${line.slice(0, 96)}`)
}

// ── the same question for the loops, for comparison ────────────────────────────────────────

const LOOPS = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  '[N/400] 正在分析代码结构...': (i) => `[${i + 1}/400] 正在分析代码结构...`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
  'Let me go.（真事故）': () => 'Let me go. ',
}
console.log(`\n${'═'.repeat(112)}`)
console.log('★ 对照：真循环的「字母/行」—— 规则必须落在它们之下')
console.log(`${'═'.repeat(112)}`)
const loopStats = []
for (const [name, make] of Object.entries(LOOPS)) {
  const line = make(0)
  const letters = (line.match(/\p{L}/gu) ?? []).length
  loopStats.push({ name, letters })
}
loopStats.sort((a, b) => a.letters - b.letters)
for (const s of loopStats) console.log(`  ${s.letters.toFixed(1).padStart(5)} 字母/行   ${s.name}`)
const floor = loopStats[0].letters
console.log(`\n  真循环的下限 = ${floor} 字母/行`)
console.log(`  诚实形状的上限 = ${Math.max(...near.map((r) => r.lpl)).toFixed(1)} 字母/行（在上面这 ${near.length} 段里）`)
console.log(
  `  ⇒ ${floor > Math.max(...near.map((r) => r.lpl)) ? '★ 分开了' : '⚠️ 重叠 —— 这一对阈值分不开两类，不能只靠字母数'}`,
)
