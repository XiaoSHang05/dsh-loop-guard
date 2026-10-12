/**
 * The discriminator: a loop's damage is measured in CHARACTERS, not lines.
 *
 * The hard negatives defeat every line-count threshold, because "twenty test emails" and
 * "four hundred fake progress steps" have the same skeleton. What they do not share is scale:
 *
 *   list.push(1..12)      12 lines  ×  13 chars =   156 chars of one skeleton
 *   user1..20@test.com    20 lines  ×  14 chars =   280 chars
 *   第 N 步：…完成。       400 lines ×  15 chars = 6000 chars
 *
 * A legitimate enumeration ends, because the thing it enumerates ends — twelve ports, twenty
 * fixtures. A loop has nothing to end it, so it keeps paying the same sentence out until the
 * token ceiling. Charging the budget in characters is therefore not a trick to dodge the
 * negatives: it is the quantity that actually separates the two.
 *
 * This file finds the smallest budget that stays silent on every hard negative, and reports
 * what that costs in latency on the loops.
 */

const BUDGETS = [200, 300, 400, 600, 800, 1200, 1600, 2400, 4000]
const MIN_LINES = 4

function skeleton(line) {
  return line.replace(/\d+/gu, '#')
}

function isBlank(line) {
  return line.trim() === ''
}

function hasContent(text) {
  const seen = new Set()
  for (const ch of text) {
    if (ch === ' ' || ch === '\t') continue
    seen.add(ch)
    if (seen.size >= 2) return true
  }
  return false
}

/**
 * The longest run of consecutive lines sharing a skeleton, with its total character weight.
 *
 * `chars` counts the whole line, not just the skeleton: what fills the context window is the
 * line as emitted, numbers and all.
 */
function scanStruct(text) {
  const lines = text.split('\n').filter((line) => !isBlank(line))
  let best = { run: 0, chars: 0, sample: '' }
  let run = 0
  let chars = 0
  let current = ''

  for (const line of lines) {
    const key = skeleton(line)
    const usable = hasContent(key) && key.length >= 4
    if (usable && key === current) {
      run += 1
      chars += line.length
    } else {
      run = usable ? 1 : 0
      chars = usable ? line.length : 0
      current = usable ? key : ''
    }
    if (chars > best.chars) best = { run, chars, sample: line }
  }
  return best
}

function feed(text, budget, chunk = 16) {
  for (let i = 0; i < text.length; i += chunk) {
    const fed = Math.min(i + chunk, text.length)
    const seen = scanStruct(text.slice(0, fed))
    if (seen.run >= MIN_LINES && seen.chars >= budget) {
      return { hit: true, chars: fed, run: seen.run, weight: seen.chars, sample: seen.sample }
    }
  }
  return { hit: false, chars: text.length, run: 0, weight: 0, sample: '' }
}

// ── hard negatives, now with their true length ────────────────────────────────────────────

const HARD_NEGATIVES = {
  '① list.push(1..12)': Array.from({ length: 12 }, (_, i) => `list.push(${i + 1})`).join('\n'),
  '② user1..20@test.com': Array.from({ length: 20 }, (_, i) => `user${i + 1}@test.com`).join('\n'),
  '③ v1.2.0 .. v1.2.9': Array.from({ length: 10 }, (_, i) => `- v1.2.${i}`).join('\n'),
  '④ port 8001..8010': Array.from({ length: 10 }, (_, i) => `port ${8001 + i}`).join('\n'),
  '⑤ 同类别表格行 ×10': Array.from({ length: 10 }, (_, i) => `| 电缆 | ${120 + i * 10} |`).join('\n'),
  '⑥ 日期序列 ×14': Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).join('\n'),
  '⑦ IP 列表 ×12': Array.from({ length: 12 }, (_, i) => `192.168.1.${i + 1}`).join('\n'),
  '⑧ 测试用例 ×12': Array.from({ length: 12 }, (_, i) => `it('case ${i + 1}', () => { expect(f(${i + 1})).toBe(${i + 1}) })`).join('\n'),
  '⑨ CSS 类 ×10': Array.from({ length: 10 }, (_, i) => `.col-${i + 1} { width: ${(i + 1) * 10}% }`).join('\n'),
  '⑩ 数组字面量 ×12': Array.from({ length: 12 }, (_, i) => `  ${i + 1},`).join('\n'),
  '⑪ SQL 批量 ×10': Array.from({ length: 10 }, (_, i) => `INSERT INTO t VALUES (${i + 1}, 'x');`).join('\n'),
  '⑫ 编号书目 ×10': Array.from({ length: 10 }, (_, i) => `${i + 1}. 文献标题第${i + 1}版`).join('\n'),
  '⑬ 等宽数字列 ×12': Array.from({ length: 12 }, (_, i) => `| ${i + 1} | ${(i + 1) * 100} |`).join('\n'),
  '⑭ 地址簿 ×10': Array.from({ length: 10 }, (_, i) => `张三${i + 1}号`).join('\n'),
  '⑮ 同名小节 ×10': Array.from({ length: 10 }, (_, i) => `## ${i + 1}. 小结`).join('\n'),
  // The stretched versions: someone who really does generate a long fixture list.
  '⑯ user1..60@test.com（长夹具）': Array.from({ length: 60 }, (_, i) => `user${i + 1}@test.com`).join('\n'),
  '⑰ list.push(1..80)（长代码）': Array.from({ length: 80 }, (_, i) => `list.push(${i + 1})`).join('\n'),
  '⑱ port 8001..8060（长端口表）': Array.from({ length: 60 }, (_, i) => `port ${8001 + i}`).join('\n'),
  '⑲ 测试用例 ×50（长夹具）': Array.from({ length: 50 }, (_, i) => `it('case ${i + 1}', () => { expect(f(${i + 1})).toBe(${i + 1}) })`).join('\n'),
}

const LOOPS = {
  'A 第 N 步：读取配置文件完成。': Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 步：读取配置文件完成。`).join('\n'),
  'B 检查项 N/400：文件存在 —— 通过。': Array.from({ length: 400 }, (_, i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`).join('\n'),
  'C 好，现在处理第 N 个问题。': Array.from({ length: 400 }, (_, i) => `好，现在处理第 ${i + 1} 个问题。`).join('\n'),
  'D [N/400] 正在分析代码结构...': Array.from({ length: 400 }, (_, i) => `[${i + 1}/400] 正在分析代码结构...`).join('\n'),
  'E 第 N 次尝试：连接数据库超时。': Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 次尝试：连接数据库超时。`).join('\n'),
  'F 已处理 N 条记录，继续下一条。': Array.from({ length: 400 }, (_, i) => `已处理 ${i + 1} 条记录，继续下一条。`).join('\n'),
  'G 英文 Step N: reading config done.': Array.from({ length: 400 }, (_, i) => `Step ${i + 1}: reading config done.`).join('\n'),
}

function pad(text, width) {
  const s = String(text)
  let wide = 0
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) wide += 1
  const visible = s.length + wide
  return visible >= width ? s : s + ' '.repeat(width - visible)
}

console.log(`${pad('样本', 34)} ${BUDGETS.map((b) => pad(`${b}`, 9)).join('')}`)
console.log('─'.repeat(34 + 9 * BUDGETS.length))

let firstFalsePositive = null
for (const [name, text] of Object.entries(HARD_NEGATIVES)) {
  const cells = BUDGETS.map((b) => {
    const r = feed(text, b)
    if (r.hit && firstFalsePositive === null) firstFalsePositive = { name, budget: b, weight: r.weight }
    return pad(r.hit ? `✗${r.weight}字` : '✓', 9)
  })
  console.log(`${pad(name, 34)} ${cells.join('')}`)
}

console.log(`\n${pad('—— 循环样本（几行抓到 / 流出多少字）——', 34)}`)
for (const [name, text] of Object.entries(LOOPS)) {
  const cells = BUDGETS.map((b) => {
    const r = feed(text, b)
    return pad(r.hit ? `${r.run}行/${r.chars}字` : '漏', 9)
  })
  console.log(`${pad(name, 34)} ${cells.join('')}`)
}

console.log(`\n★ 最早误报：${firstFalsePositive ? `${firstFalsePositive.name} 在预算 ${firstFalsePositive.budget} 时报（${firstFalsePositive.weight} 字）` : '无'}`)
