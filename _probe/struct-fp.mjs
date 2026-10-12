/**
 * The false positives the budget is hiding, shown rather than counted.
 *
 * `struct-sweep.mjs` reported a cliff: a 500-character budget fires on 276 ordinary messages,
 * a 600-character budget fires on none. The heaviest run in the whole corpus is 543 characters,
 * so the "clean" cell is not clean because the rule is right — it is clean because nothing on
 * this machine ever got that heavy. One more table in one more session and the detector starts
 * interrupting honest answers.
 *
 * This prints the runs sitting just under the line, so the threshold can be chosen by looking
 * at the shapes instead of by reading a zero. For each one it also reports what fraction of the
 * line is digits, because that is the one thing a coordinate listing and a fake-progress loop
 * do not share: a listing is mostly numbers repeating a *format*, a loop is mostly words
 * repeating a *sentence* with a fresh number glued on.
 *
 *   node _probe/struct-fp.mjs 12 500     # runs with >=12 lines and >=500 chars
 */

import { readFileSync } from 'node:fs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

const minLines = Number(process.argv[2] ?? 12)
const minChars = Number(process.argv[3] ?? 500)

const all = []
for (const message of cache.messages) {
  for (const run of message.runs) {
    if (run.lines < minLines || run.chars < minChars) continue
    all.push({ ...run, sessionId: message.sessionId, kind: message.kind })
  }
}
all.sort((a, b) => b.chars - a.chars)

const digitShare = (text) => {
  const digits = (text.match(/\d/gu) ?? []).length
  return digits / Math.max(1, text.length)
}

/** Word characters left once digits, punctuation and spaces are gone. */
const wordShare = (text) => {
  const words = text.replace(/[\d\s\p{P}\p{S}]/gu, '')
  return words.length / Math.max(1, text.length)
}

console.log(`连跑 ≥${minLines} 行 且 ≥${minChars} 字 ⇒ ${all.length} 段`)
console.log('这些就是 500 字预算会误伤、600 字预算侥幸放过的形状。\n')
console.log(`${'字数'.padStart(6)} ${'行数'.padStart(4)} ${'字/行'.padStart(6)} ${'数字占比'.padStart(8)} ${'文字占比'.padStart(8)}  样本`)
console.log('─'.repeat(118))

for (const run of all.slice(0, 30)) {
  const perLine = run.chars / run.lines
  console.log(
    `${String(run.chars).padStart(6)} ${String(run.lines).padStart(4)} ${perLine.toFixed(1).padStart(6)} ` +
      `${(digitShare(run.sample) * 100).toFixed(0).padStart(7)}% ${(wordShare(run.sample) * 100).toFixed(0).padStart(7)}%  ` +
      `${run.sample.slice(0, 60)}`,
  )
}

// What the same statistics look like on the loops this rule exists to catch.
const LOOPS = {
  '第 N 步：读取配置文件完成。': (i) => `第 ${i + 1} 步：读取配置文件完成。`,
  '检查项 N/400：文件存在 —— 通过。': (i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`,
  '好，现在处理第 N 个问题。': (i) => `好，现在处理第 ${i + 1} 个问题。`,
  'Step N: reading config done.': (i) => `Step ${i + 1}: reading config done.`,
  '已处理 N 条记录，继续下一条。': (i) => `已处理 ${i + 1} 条记录，继续下一条。`,
}
console.log(`\n${'─'.repeat(118)}`)
console.log('对照：真循环的同一组统计\n')
console.log(`${'形状'.padEnd(34)} ${'字/行'.padStart(6)} ${'数字占比'.padStart(8)} ${'文字占比'.padStart(8)}`)
for (const [name, make] of Object.entries(LOOPS)) {
  const line = make(0)
  console.log(
    `${name.padEnd(34)} ${line.length.toFixed(1).padStart(6)} ` +
      `${(digitShare(line) * 100).toFixed(0).padStart(7)}% ${(wordShare(line) * 100).toFixed(0).padStart(7)}%`,
  )
}
