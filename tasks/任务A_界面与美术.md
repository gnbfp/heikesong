# 任务 A：界面美术与交互动画专业化

> 给执行本任务的 AI：你是一个资深前端/游戏视觉工程师。请先读完本文件，再动手。工作产物必须**不破坏现有功能、不破坏测试**。

---

## 0. 一句话目标

在**零构建、纯 CSS、无第三方库**的前提下，把表现层从"可用"推到"专业级"：转场、门材质、舞台氛围、结算成绩卡、音效与情绪气泡，全部纯 CSS/DOM + WebAudio 合成实现，并保证 `node tests/run-all.js` 不退化。

## 1. 仓库与基线

- 仓库：`https://github.com/gnbfp/heikesong`（若无法访问，用你本地的项目副本，结构与之一致）
- 分支：`codex/stage0-1-vertical-slice`
- 基线验收（你必须在改动前自己跑一遍）：
  ```bash
  node tools/build-data.js --check     # exit 0
  node tests/run-all.js                # 8 套件 514 PASS / 0 FAIL / 9 SKIP，exit 0
  ```
- 基线**必须保持**：你交付后 `run-all` 不得出现新的 FAIL（SKIP 是 headless Edge 在本环境起不来，属预期）。

## 2. 文件地图（只读了解，不要改）

| 文件 | 职责 |
|---|---|
| `index.html` | DOM 结构；**脚本加载顺序**：state → data → effects → narrator → ui → game（严禁改成 ES module） |
| `js/game.js` | 引擎；只通过 `payload` 调 UI：`render/flash/toast/banner/openModal/closeModal/playNarratorLine/playHostOpen/playReveal`
| `js/state.js` | `GameState` 字段、状态机、RNG、`CodexStore` |
| `js/data.js` | **生成物**（由 `tools/build-data.js` 从 `data/*.json` 生成，不要手改） |
| `tests/run-all.js` | 8 个套件：build-data --check / sim / shop / features / ux / doors / dom-smoke / headless-check |

## 3. 允许修改的文件（严格范围）

- `js/ui.js`（唯一 UI 实现，2.3k 行）
- `style.css`
- 其余一律**不改**：`js/game.js`、`js/state.js`、`data/**`、`tools/**`、`tests/**`、`index.html`

若某个效果必须改 DOM 或引擎，**停下来回报**，不要擅自改。

## 4. 必做项（验收逐条对应）

- **A1 转场动画**：轮次进入/退出、结算页入场（成绩卡从下方弹入 + 数字滚动）。总时长 ≤ 420ms，可被 `prefers-reduced-motion` 或 `flags.reducedFx` 一键降级。
- **A2 门材质**：随牌面 rarity（`item.rarity` 或按 kind 映射）表现不同质感（木纹/金属高光/暗纹），**不得在开门前泄露具体牌面**。
- **A3 舞台氛围**：观众席剪影、聚光灯、暗角（纯 CSS 渐变/伪元素，`pointer-events:none`，不产生滚动条）。
- **A4 HUD**：金币变化时数字滚动 + "金币飞入"粒子；怀疑值/耐心变化闪烁。
- **A5 点击交互**：门按钮 hover/active/disabled 三态分明；触屏命中区 ≥44×44px；长按窥视有进度反馈。
- **A6 旁白情绪**：气泡按 3 种人格（毒舌/温柔/癫狂）切换边框/颜色/抖动节奏；打字机效果可跳过。
- **A7 音效**：现有 WebAudio 合成层（`js/ui.js` 音效段）增强：BGM 低频 pad（可静音）+ 事件音；全部 try/catch、无 `AudioContext` 环境静默降级。
- **A8 结算成绩卡**：结局标题 + 成就新解锁徽章 + 图鉴进度 + "再来一局"主按钮；不改变引擎传入的数据结构。

## 5. 硬约束

1. 零外链、零图片下载、零第三方库、零构建链（双击 `index.html` 必须能跑，`file://` 下不能有 CORS 报错）。
2. 不改任何 `id`/`class`/`aria-*` 的现有语义（`tests/dom-smoke.js` 依赖）；新增元素用 `dd-` 前缀类或新 id。
3. 动画只用 `transform`/`opacity`（避免 layout thrash）；单次动画 ≤ 420ms；连点 50 次不出错。
4. `run-all` 不得退化；且你自己要写 **20 条无头 E2E 断言**（Node 环境，fake DOM 垫片或直接断言纯函数），附在交付说明中——本环境无法启动真实浏览器（沙箱限制），你只能静态验证。

## 6. 必须实测的验收

```bash
node --check js/ui.js                     # exit 0
node tests/run-all.js                     # 514+ PASS / 0 FAIL / 9 SKIP，exit 0
node tools/build-data.js --check          # exit 0（证明你没碰数据层）
```
并在交付说明中给出**六档视口的静态推算表**（1280×720 / 1920×1080 / 1366×768 / 1366×657 / 3440×1440 / 667×375）：门卡尺寸、是否产生滚动条、是否裁切。

## 7. 交付格式（回给整合者）

一个目录，内含：
```
交付说明.md      # 改动清单（文件+行区间）、每个效果与验收项的对应关系、验收命令输出原文、六档视口推算表、已知取舍
js/ui.js        # 修改后的完整文件
style.css       # 修改后的完整文件
files/          # 与仓库相对路径一致的副本（files/js/ui.js、files/style.css）
```

## 8. 整合方式（写给你，也写给整合者）

整合者会把你的交付目录放进工作区，执行：
```bash
node handoff/integrate.js --dir <你的交付目录> --scope a      # 结构校验 + 范围校验 + 沙箱演练
node handoff/integrate.js --dir <你的交付目录> --scope a --apply  # 写回仓库
node tests/run-all.js                                          # 全量回归（必须 0 FAIL）
```
合并冲突时以整合者为准；你只需保证文件完整、路径正确、测试全绿。
