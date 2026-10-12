/**
 * Look at what sits just under the threshold, in full.
 *
 * The sweep says a 600-character budget fires on nothing in 32,107 ordinary messages, and a
 * 500-character budget fires on 276 of them. The heaviest run in the whole corpus is 543
 * characters. That means the budget is not standing on the edge of the phenomenon — it is
 * standing 10% above the tallest thing this one machine happens to have written.
 *
 * A threshold chosen that way is a threshold that breaks on the next machine. Before trusting
 * it, read the tail: these are the runs a slightly lower budget would have interrupted, and
 * the question is whether they look like loops or like work.
 *
 *   node _probe/struct-tail.mjs          # top 4 runs, every line, with context
 *   node _probe/struct-tail.mjs 12 500   # runs with >=12 lines and >=500 chars
 */

import { readFileSync } from 'node:fs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

const minLines = Number(process.argv[2] ?? 0)
const minChars = Number(process.argv[3] ?? 0)

const all = []
for (const message of cache.messages) {
  for (const run of message.runs) {
    if (run.lines < minLines || run.chars < minChars) continue
    all.push({ ...run, sessionId: message.sessionId, kind: message.kind, total: message.chars })
  }
}
all.sort((a, b) => b.chars - a.chars)

console.log(`筛选：≥${minLines} 行 且 ≥${minChars} 字 ⇒ ${all.length} 段连跑`)
console.log(`（整份语料里最重的连跑是 ${all[0]?.chars ?? 0} 字）\n`)

/**
 * How much of each line is *not* digits.
 *
 * A counter loop and a coordinate listing both survive skeleton masking: in both, every line
 * reduces to the same string of punctuation and words. What differs is how much real text is
 * left once the digits are gone, and whether that remainder is the *same* on every line.
 *
 * A loop repeats one sentence with a new number glued on: the remainder is short and identical.
 * A listing repeats a *format*: the remainder is long, and it is only identical because the
 * format is. So the length of the remainder — not the length of the line — is the thing worth
 * measuring, and this prints it for every line so the claim can be checked rather than assumed.
 */
function remainder(line) {
  return line.replace(/\d+/gu, '').replace(/\s+/gu, ' ').trim()
}

for (const run of all.slice(0, 4)) {
  console.log('═'.repeat(100))
  console.log(`${run.chars} 字 / ${run.lines} 行 · ${run.kind} · ${run.sessionId}`)
  console.log('─'.repeat(100))
  for (const line of run.text.split('\n')) {
    const rest = remainder(line)
    console.log(`  ${String(line.length).padStart(4)}字  余${String(rest.length).padStart(3)}字 │ ${line.slice(0, 92)}`)
  }
  const rests = run.text.split('\n').map(remainder)
  const unique = new Set(rests)
  console.log(
    `  ⇒ 非数字余量：${unique.size} 种 / ${rests.length} 行` +
      ` · 余量长度 ${Math.min(...rests.map((r) => r.length))}–${Math.max(...rests.map((r) => r.length))} 字`,
  )
  console.log('')
}
