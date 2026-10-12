/**
 * Which surviving cell to ship, decided by latency rather than by taste.
 *
 * `struct-final.mjs` lists every cell that is clean on this corpus, ordered by margin. Margin
 * alone does not pick one: 30行/≥10字母 has the most room and also the worst latency, and a guard
 * that fires at 891 characters has let the runaway print three times the text it needed to.
 *
 * So this prints the two candidate rows side by side. The letters threshold decides *which*
 * loops are visible at all — the Chinese shapes carry 8–10 letters per line, so ≥8 catches all of
 * them and ≥10 misses three. The lines threshold decides how late it fires.
 *
 *   node _probe/struct-pick.mjs
 */

import { readFileSync } from 'node:fs'

const cache = JSON.parse(readFileSync(new URL('./struct-real-cache.json', import.meta.url), 'utf8'))

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

console.log('★ 每个真循环形状每行有多少个字母 —— 字母阈值决定它可不可见')
for (const [name, make] of Object.entries(SHAPES)) {
  const letters = (make(0).match(/\p{L}/gu) ?? []).length
  console.log(`  ${String(letters).padStart(3)} 字母/行   ${name}`)
}

const CELLS = []
for (const L of [8, 10, 12, 14, 16, 20, 24, 30]) {
  for (const A of [6, 8, 10]) {
    if (runs.filter((r) => r.lines >= L && r.lettersPerLine >= A).length === 0) CELLS.push({ L, A })
  }
}

console.log(`\n★ 零误伤格子共 ${CELLS.length} 个，逐个看延迟`)
console.log(`${'形状'.padEnd(30)}${CELLS.map((c) => `${c.L}行/${c.A}L`.padStart(11)).join('')}`)
for (const [name, make] of Object.entries(SHAPES)) {
  process.stdout.write(name.padEnd(30))
  for (const cell of CELLS) {
    let chars = 0
    let found = null
    for (let i = 0; i < 5000 && found === null; i += 1) {
      const line = make(i)
      chars += line.length + 1
      const letters = (line.match(/\p{L}/gu) ?? []).length
      if (i + 1 >= cell.L && letters >= cell.A) found = { at: i + 1, chars }
    }
    process.stdout.write((found === null ? '漏' : `${found.at}行/${found.chars}字`).padStart(11))
  }
  console.log('')
}
