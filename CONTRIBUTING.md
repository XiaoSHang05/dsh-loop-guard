# 参与开发

这是一个 DSH 插件的源码仓库。感谢你先看完这几条——它们都是踩过的坑，不是流程装饰。

## 先能跑起来

```bash
npm install     # jsdom / react / react-dom / @deepseek-ai/schemastery
npm run build   # src/client.js + src/client.css → lib/client.js
npm test        # 静态校验 + 八组测试台
node _probe/mutation.mjs
```

`lib/client.js` 是**生成物**，不要手改：它是 `scripts/build-client.mjs` 把 `src/client.js` 与 `src/client.css` 拼成的浏览器模块。改了源码忘了重建，`npm test` 的静态校验会直接失败（它会比对产物与源码字节是否一致）——这是故意的，否则测试台跑的是昨天的代码。

## 提交前请自己回答这四个问题

1. **这个改动有无断言？** 没有断言的改动会在下一次重构时静默消失。测试台都在 `_probe/`，用 `node _probe/xxx.mjs` 单独跑。
2. **这个断言真的能失败吗？** 加完断言后，把 bug 放回源码跑一遍，必须变红；跑红了再恢复。`_probe/mutation.mjs` 就是这套机制的自动化版本——新台子建议也加一条变异进去。一个永远绿的台子比没有台子更糟。
3. **改动碰了几层？** 跨半改动（`src/index.js` ↔ `src/client.js`）要同时更新 `CONTRACT.md`，并跑 `_probe/contract/wire.mjs`。历史上出过的最贵 bug 都是「两半各自全绿、缝上对不上」。
4. **文档里那个数还是真的吗？** 改了阈值就改 `README.md`、`CONTRACT.md`、`VALIDATION.md` 里引用的数字与断言计数。

## 硬性约束（静态校验会拦）

- `src/client.css` 里不许出现任何颜色字面量（`#hex`、`rgb()`、`hsl()`），必须用主题令牌 `var(--dsw-alias-*)`。硬编码的颜色是暗色模式 bug。
- `src/client.js` 里不许出现 JSX——构建步骤只做拼接，不编译。
- 不许用 `alert()` / `confirm()` / `prompt()`。
- 用到的客户端能力必须在 `package.json` 的 `dsh.client.inject` 里声明，否则线渲染到一半才 `undefined`。
- 机器相关路径（家目录、本机安装位置、监听地址）只能写在 `_probe/env.mjs` 一处，其它文件出现即失败。注意这条规则也扫文档：连在说明文字里提到这些字面量都会让校验变红。
- 提交前跑 `node scripts/check.mjs`，它会同时检查产物新鲜度、语法、越权能力、清单路径与上面这些。

## 关于测试台的一个约定

测试台的输出格式**故意不统一**（`detect: 74/74 checks passed` / `ALL 11 PASS`）。`scripts/test.mjs` 因此只引用每个台子的最后一行输出，而不是 grep 某个固定词组——一个要求统一措辞的 runner，会在某个大声失败的台子上静默报 `ok`。

## 报告问题

请附上：DSH 版本、Node 版本、`GET /dsh-rice-guard/api/state` 的返回（其中含版本、配置与最近命中）、以及你认为误报或漏报的那段原文。命中记录里的 `unit` 字段就是判定时用的那段文本。

隐私提醒：`state` 返回里有会话 id 与标题。贴出来之前请自行截断。
