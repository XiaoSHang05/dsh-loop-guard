// 探索：分段式 / 跳跃式重复，当前两条检测规则各能不能抓到。
// 这是探针，不是断言台——先看清行为，再决定要不要写成断言。
import { createDetector } from '../src/detect.js'

/** 按行喂，每喂一行报一次，返回第一条命中的形状。 */
function feed(name, lines, options = {}) {
  const d = createDetector(options)
  for (let i = 0; i < lines.length; i += 1) {
    const hit = d.push('text', lines[i] + '\n')
    if (hit) {
      return { name, caught: true, atLine: i + 1, kind: hit.kind, repeats: hit.repeats, unit: hit.unit }
    }
  }
  const snap = d.snapshot().text
  return { name, caught: false, atLine: null, kind: null, repeats: snap.repeats, unit: snap.unit, score: snap.score }
}

const cases = []

/* 1. 连续同一条（基线，应该必抓） */
cases.push(feed('基线·同一行连写', Array(20).fill('Let me go.')))

/* 2. 用户描述：一 / 二 / 四 三行一循环，连着来 */
const trio = ['一', '二', '四']
cases.push(feed('三行循环·连着来', Array.from({ length: 15 }, (_, i) => trio[i % 3])))

/* 3. 用户描述：同样三行循环，但中间被别的句子隔开 */
cases.push(
  feed(
    '三行循环·被隔开',
    Array.from({ length: 6 }, () => [...trio, '这里是一句无关的过渡话，长度也不一样。']).flat(),
  ),
)

/* 4. 跳跃式：同样的几行，顺序被打乱（内容重复但顺序不同） */
cases.push(
  feed('跳跃·同几行乱序', ['一', '二', '四', '二', '四', '一', '四', '一', '二', '一', '四', '二', '四', '二', '一']),
)

/* 5. 长周期行循环：五行一循环（周期 5 行） */
const five = ['甲', '乙', '丙', '丁', '戊']
cases.push(feed('五行循环', Array.from({ length: 25 }, (_, i) => five[i % 5])))

/* 6. 短行对循环：两行一循环（周期 2 行） */
cases.push(feed('两行循环', Array.from({ length: 20 }, (_, i) => (i % 2 ? '乙乙乙乙' : '甲甲甲甲'))))

/* 7. 单字符行循环：一 / 二 两行，但每行只有一个字（长度不够 minUnit） */
cases.push(feed('两行·单字', Array.from({ length: 20 }, (_, i) => (i % 2 ? '乙' : '甲'))))

/* 8. 分段式：同一段整块重复，但两块之间隔了不同长度的内容 */
cases.push(
  feed(
    '整块重复·间隔不等',
    [
      '第一段开头。',
      '第一段中间。',
      '第一段结尾。',
      '过渡一。',
      '第一段开头。',
      '第一段中间。',
      '第一段结尾。',
      '过渡一。',
      '过渡二，比上面长一些。',
      '第一段开头。',
      '第一段中间。',
      '第一段结尾。',
    ],
  ),
)

/* 9. 长行重复但每次行首带递增序号（真实日志形状） */
cases.push(
  feed(
    '带序号的行',
    Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 步：检查配置项并重试连接。`),
  ),
)

/* 10. 健康对照：正常散文，不该报警 */
cases.push(
  feed('健康·正常散文', [
    '先说结论：这条通道坏了。',
    '证据在存储里，房间数据是完好的。',
    '所以问题出在投影那一段。',
    '修法是另开一条同源 HTTP 路由。',
    '这样就不依赖那个坏掉的通道了。',
    '最后记得重启宿主。',
    '刷新页面就能看到新代码。',
    '完。',
  ]),
)

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('形状', 22), pad('抓到', 6), pad('第几行', 8), pad('规则', 8), pad('次数', 6), '片段')
for (const c of cases) {
  console.log(
    pad(c.name, 22),
    pad(c.caught ? '✅' : '❌', 6),
    pad(c.atLine ?? '-', 8),
    pad(c.kind ?? '-', 8),
    pad(c.repeats ?? '-', 6),
    JSON.stringify((c.unit ?? '').slice(0, 40)),
  )
}
