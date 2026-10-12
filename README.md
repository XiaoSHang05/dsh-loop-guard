# 循环守卫 · dsh-loop-guard

DSH 的独立插件：监视模型的**思考流和正式输出流**，发现重复内容后报警，并可自动停止当前回合。无需群聊插件；功能坞可选，不构成硬依赖。

## 安装与入口

兼容当前验证的 DSH `0.2.0-rc.2`；包声明范围为 `>=0.2.0-0 <0.3.0`。宿主需要提供 `webServer` 和 agent 运行时，以及 `@deepseek-ai/schemastery ^3.18.1`。

在包含本文件与 package.json 的插件目录中安装：

```powershell
dsh plugin --profile desktop add "link:$($PWD.Path)"
```

**安装或更新宿主代码后重启 DSH**，然后刷新原来的网页。对话区会出现「监控」标签页。报警挂在全局浮层，无需一直停留在监控页。已安装过旧目录时，请先在插件管理器里处理旧链接，再装交付目录，避免两个目录的同名插件混用。

该命令走 DSH 的包安装流程。若现有 profile 的其他依赖触发包龄等供应链限制，安装可能失败；不要为本插件放宽整个 profile 的安全策略。检查失败信息后再处理对应依赖。本机此前已登记开发目录链接，交付文件夹不会自动替换那个链接。

## 使用

- 默认监视全部会话，思考与输出分别检测。
- 「启用监控」控制全局开关；会话行可以暂停/恢复单独监控。
- 「重复次数」控制**连续周期重复**阈值，默认 5。
- 「重复行占比」控制**独立的重复行检测**，默认最近 8 行中 75% 是已出现的行。调高重复次数不会关闭这条规则，需要同时调整重复行占比。
- 命中后会显示会话、流、重复片段、次数与打断状态。报警不会自动消失，点击「知道了」才关闭；关闭请求失败时卡片保留。
- 提示音使用 WebAudio。浏览器可能要求先与页面交互才能播放声音；声音不可用不影响报警卡片或宿主打断。
- 配置 `cancel: false` 可切换为只报警；`alarm: false` 不显示卡片；`sound: false` 关闭声音。
- 功能坞的客户端桥接可用时尝试注册入口；桥接不可用时仍可使用监控页和独立报警。

## 检测与边界

1. **周期重复**：在尾部窗口寻找连续相同片段；展示时把英文周期旋转到可读词边界。
2. **重复行密度**：只归一化行首尾和连续空白，再比较相同的行。数字不同仍是不同内容，不把正常进度列表、带变化计数的重试日志视为重复行。
3. **一次命中锁存**：同一流在同一请求中只报告一次；新请求或重新配置时清空检测缓存。

宿主通过 `agent/assistant-stream` 全局订阅实时增量，命中后调用：

```js
agent.cancel(
  { kind: 'hook', reason: 'loop-guard: repeated output' },
  { keepInbox: true },
)
```

这是**回合级止损**，不是逐段撤回：已经输出的字无法收回。保留排队输入不等于撤销已执行的工具操作。正常文章故意重复很多次也可能被打断，可按场景暂停监控或改成只报警。

只由空白或单个不同字符组成的片段会被排除，避免分隔线误报；因此单字符刷屏不是本版的检测目标。超出窗口长度/周期长度的重复也可能漏检。未加载插件之前的输出不能回溯检测。

## 配置

监控页的修改先立即作用于本插件，再尽力通过宿主 Settings 持久化。若 Settings 缺席或写入失败，配置仅保存在内存中。会话级暂停/恢复名单和命中历史均为内存数据，重启后清空。历史最多 50 条，默认界面展示最新 20 条。

| 配置键 | 默认值 | 含义 |
| --- | --- | --- |
| enabled | true | 全局监控开关 |
| minRepeat | 5 | 连续周期重复阈值 |
| minUnit / maxUnit | 6 / 1024 | 搜索周期长度范围 |
| windowChars | 8192 | 各流保留的尾部窗口 |
| densityLines / densityRatio | 8 / 0.75 | 重复行窗口与占比 |
| cancel / alarm / sound | true | 自动打断、报警卡片、提示音 |
| scopeDefault | all | 默认全部监控；selected 仅监控显式选中的会话 |

`checkEvery=32` 是核心内部默认扫描步长，不是宿主 HTTP 配置字段。`watchText`、`watchReasoning`、`excludedSessions` 不属于本版配置 API。

## 结构

- `src/detect.js`：纯检测核心。
- `src/index.js`：宿主半，包含流订阅、配置、命中记录、取消与 HTTP/SSE。
- `src/client.js`、`src/client.css`：监控页与报警。
- `lib/client.js`：已构建的浏览器模块，无需再构建即可安装。
- `cordis.patch.yml`：安装条目，id 为 `loop-guard`。
- `CONTRACT.md`：跨半数据契约。
- `VALIDATION.md`：交付验证记录与证据边界。

读写接口位于 `/dsh-loop-guard/api/`：`health`、`state`、`config`、`monitor`、`hits`、`events`。SSE 只通知重新读取，状态以 GET state 为准；连接异常时退回轮询。接口使用宿主 Web 的认证边界，不额外提供公网认证。

## 开发与测试（完整源码目录）

交付文件夹包含源码、构建脚本和测试脚本，但不携带 node_modules、浏览器个人配置、凭据或 DSH 会话日志。测试的 React/jsdom 依赖声明在 `_probe/render/package.json`，需要先安装其开发依赖；运行宿主测试也需要可解析的 Schemastery。

```powershell
node scripts/build-client.mjs
node scripts/check.mjs
node scripts/test.mjs
node _probe/mutation.mjs
```

七组测试覆盖检测核心、宿主路由、流订阅、客户端报警/推送、跨半契约和真实 React/jsdom 挂载。变异台会临时改写三个源码文件并在 finally 中恢复，**不要与其他编辑或构建并行运行**。

MIT，见 LICENSE。
