/**
 * What the threshold is actually standing on.
 *
 * `struct-sweep.mjs` found that a budget of 600 characters of consecutive same-skeleton lines
 * fires on none of the 32,107 ordinary messages in the corpus, while 500 fires on 276 of them.
 * A cliff that sharp is a warning, not a result: it says the boundary sits where this corpus
 * happens to end, not where the phenomenon does. One more table in one more session and the
 * detector starts interrupting honest answers.
 *
 * So this prints the tail itself — the heaviest runs, in order — and the samples that produced
 * them. A threshold is only defensible if you have looked at what sits just under it.
 *
 *   node _probe/struct-dump.mjs            # heaviest 25 runs
 *   node _probe/struct-dump.mjs 400 600    # only runs in that character band
 */

import { readFileSync } from 'node:fs'

const CACHE = new URL('./struct-real-cache.json', import.meta.url)
const cache = JSON.parse(readFileSync(CACHE, 'utf8'))

const lo = Number(process.argv[2] ?? 0)
const hi = Number(process.argv[3] ?? Number.POSITIVE_INFINITY)
const top = Number(process.argv[4] ?? 25)

/** Every run in the corpus, flattened, heaviest first. */
const all = []
for (const message of cache.messages) {
  for (const run of message.runs) all.push({ ...run, sessionId: message.sessionId, kind: message.kind, total: message.chars })
}
all.sort((a, b) => b.chars - a.chars)

const inBand = all.filter((run) => run.chars >= lo && run.chars < hi)

console.log(`语料：${cache.messages.length} 条有连跑的消息，共 ${all.length} 段连跑`)
console.log(`最重的一段：${all[0].chars} 字 / ${all[0].lines} 行\n`)

// The shape of the tail, so the cliff can be read rather than guessed at.
console.log('★ 最重连跑的字数分布（每格 = 有多少条消息的最重连跑落在该区间）')
const BANDS = [100, 200, 300, 400, 500, 550, 600, 700, 800, 1000, 1500, 2000, 4000]
const heaviest = new Map()
for (const run of all) {
  const previous = heaviest.get(run.sessionId + run.kind)
  if (previous === undefined || run.chars > previous) heaviest.set(run.sessionId + run.kind, run.chars)
}
let previousBand = 0
for (const band of BANDS) {
  let count = 0
  for (const chars of heaviest.values()) if (chars >= previousBand && chars < band) count += 1
  console.log(`   ${String(previousBand).padStart(5)} – ${String(band).padEnd(5)} 字 : ${count} 条`)
  previousBand = band
}
let beyond = 0
for (const chars of heaviest.values()) if (chars >= previousBand) beyond += 1
console.log(`   ≥ ${previousBand}       字 : ${beyond} 条`)
console.log('')

console.log(`★ 落在 ${lo} – ${hi} 字区间的连跑：${inBand.length} 段，展示前 ${top} 段`)
console.log('─'.repeat(100))
for (const run of inBand.slice(0, top)) {
  const sample = run.sample.length > 96 ? `${run.sample.slice(0, 96)}…` : run.sample
  console.log(`${String(run.chars).padStart(6)} 字 / ${String(run.lines).padStart(3)} 行  ${sample}`)
}
