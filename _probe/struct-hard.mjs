/**
 * The adversarial half: ordinary content that LOOKS like a counter loop.
 *
 * The first probe used tables and logs whose labels vary, so every skeleton differed and the
 * zero-false-positive result proved less than it appeared to. This file is the harder half.
 *
 * The distinction that matters is not "does the text have numbers in it" but "is the same
 * template being filled in repeatedly". That happens legitimately all the time:
 *
 *   list.push(1) ... list.push(12)          a literal being filled into one call
 *   user1@test.com ... user20@test.com      generated fixtures
 *   - v1.2.0 ... - v1.2.9                   a changelog
 *   port 8001 ... port 8010                 a port map
 *
 * and it happens pathologically as a loop:
 *
 *   第 1 步：读取配置文件完成。 ... 第 400 步：...
 *
 * At the skeleton level these are the SAME shape. So the question this file answers is not
 * "can a skeleton detector work" — it can — but "at what threshold does it stop lying".
 */

const THRESHOLDS = [4, 6, 8, 10, 12, 16, 20, 24, 30]

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
 * `minChars` is the second lever: a skeleton must carry this much literal text to count.
 *
 * It exists because short skeletons are cheap to collide by accident — `v#.#.#` and `#/#` are
 * three characters of signal — while a loop repeats a *sentence*, so its skeleton is long.
 */
function scanStruct(text, minLines, minChars) {
  const lines = text.split('\n').filter((line) => !isBlank(line))
  let best = { run: 0, sample: '' }
  let run = 0
  let current = ''

  for (const line of lines) {
    const key = skeleton(line)
    const usable = hasContent(key) && key.length >= minChars
    if (usable && key === current) {
      run += 1
    } else {
      run = usable ? 1 : 0
      current = usable ? key : ''
    }
    if (run > best.run) best = { run, sample: line }
  }
  return best
}

function feed(text, minLines, minChars, chunk = 16) {
  for (let i = 0; i < text.length; i += chunk) {
    const fed = Math.min(i + chunk, text.length)
    const seen = scanStruct(text.slice(0, fed), minLines, minChars)
    if (seen.run >= minLines) return { hit: true, chars: fed, run: seen.run, sample: seen.sample }
  }
  return { hit: false, chars: text.length, run: 0, sample: '' }
}

// ── the hard negatives: ordinary content with one repeated template ───────────────────────

const HARD_NEGATIVES = {
  '① list.push(1..12) 代码': Array.from({ length: 12 }, (_, i) => `list.push(${i + 1})`).join('\n'),
  '② user1..20@test.com 测试夹具': Array.from({ length: 20 }, (_, i) => `user${i + 1}@test.com`).join('\n'),
  '③ - v1.2.0 .. v1.2.9 版本列表': Array.from({ length: 10 }, (_, i) => `- v1.2.${i}`).join('\n'),
  '④ port 8001..8010 端口表': Array.from({ length: 10 }, (_, i) => `port ${8001 + i}`).join('\n'),
  '⑤ 同类别表格行（标签也相同）': Array.from({ length: 10 }, (_, i) => `| 电缆 | ${120 + i * 10} |`).join('\n'),
  '⑥ 日期序列': Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`).join('\n'),
  '⑦ IP 地址列表': Array.from({ length: 12 }, (_, i) => `192.168.1.${i + 1}`).join('\n'),
  '⑧ 测试用例（模板相同）': Array.from({ length: 12 }, (_, i) => `it('case ${i + 1}', () => { expect(f(${i + 1})).toBe(${i + 1}) })`).join('\n'),
  '⑨ CSS 类名列表': Array.from({ length: 10 }, (_, i) => `.col-${i + 1} { width: ${(i + 1) * 10}% }`).join('\n'),
  '⑩ 数组字面量（短骨架）': Array.from({ length: 12 }, (_, i) => `  ${i + 1},`).join('\n'),
  '⑪ SQL 批量插入': Array.from({ length: 10 }, (_, i) => `INSERT INTO t VALUES (${i + 1}, 'x');`).join('\n'),
  '⑫ 编号书目（作者不同）': Array.from({ length: 10 }, (_, i) => `${i + 1}. 文献标题第${i + 1}版`).join('\n'),
  '⑬ 等宽数字列（表格）': Array.from({ length: 12 }, (_, i) => `| ${i + 1} | ${(i + 1) * 100} |`).join('\n'),
  '⑭ 地址簿（姓名相同姓）': Array.from({ length: 10 }, (_, i) => `张三${i + 1}号`).join('\n'),
  '⑮ 章节编号 + 同名小节': Array.from({ length: 10 }, (_, i) => `## ${i + 1}. 小结`).join('\n'),
}

// ── the loops again, for the same grid ────────────────────────────────────────────────────

const LOOPS = {
  'A 第 N 步：读取配置文件完成。': Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 步：读取配置文件完成。`).join('\n'),
  'B 检查项 N/400：文件存在 —— 通过。': Array.from({ length: 400 }, (_, i) => `检查项 ${i + 1}/400：文件存在 —— 通过。`).join('\n'),
  'C 好，现在处理第 N 个问题。': Array.from({ length: 400 }, (_, i) => `好，现在处理第 ${i + 1} 个问题。`).join('\n'),
  'D [N/400] 正在分析代码结构...': Array.from({ length: 400 }, (_, i) => `[${i + 1}/400] 正在分析代码结构...`).join('\n'),
}

function pad(text, width) {
  const s = String(text)
  let wide = 0
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) wide += 1
  const visible = s.length + wide
  return visible >= width ? s : s + ' '.repeat(width - visible)
}

for (const minChars of [4, 10]) {
  console.log(`\n${'█'.repeat(30)} 骨架最短 ${minChars} 字符 ${'█'.repeat(30)}\n`)
  console.log(`${pad('样本', 32)} ${THRESHOLDS.map((t) => pad(`${t}行`, 8)).join('')}`)
  console.log('─'.repeat(32 + 8 * THRESHOLDS.length))

  let worst = ''
  for (const [name, text] of Object.entries(HARD_NEGATIVES)) {
    const cells = THRESHOLDS.map((t) => {
      const r = feed(text, t, minChars)
      if (r.hit) {
        if (worst === '') worst = `${name}（${t}行就报）`
        return pad(`✗${r.run}`, 8)
      }
      return pad('✓', 8)
    })
    console.log(`${pad(name, 32)} ${cells.join('')}`)
  }
  console.log(`${pad('—— 循环样本 ——', 32)}`)
  for (const [name, text] of Object.entries(LOOPS)) {
    const cells = THRESHOLDS.map((t) => {
      const r = feed(text, t, minChars)
      return pad(r.hit ? `${r.run}行` : '漏', 8)
    })
    console.log(`${pad(name, 32)} ${cells.join('')}`)
  }
  console.log(`\n★ 最早误报：${worst || '无（全部阈值都干净）'}`)
}
