# 三扇门：别信旁白

创意互动与娱乐赛道 · 黑客松 Demo。零构建纯静态网页：**双击 `index.html` 即可运行**（也支持任意静态服务器），断网可用，无后端、无登录、无任何外部接口。

游戏规则一句话：三扇门后是大奖、小奖与空门，主持人会替你打开一扇门（普通模式优先开空门，演示剧本会故意开出炸弹/陷阱），而**旁白说的每一句话都可能是谎**。你可以坚持、换门、质疑旁白、加倍下注，或者见好就收；赚到的金币还能在**商店**里买道具（换门券、闭嘴卡、双倍金币、保险丝、神秘盒、续命符）。第三轮追加了**线索制质疑**（旁白会给出可验证的「N 号门里是…」）、连击加成、怀疑值恢复与 **8 种结局**。

## 快速开始

```powershell
# 方式一：直接双击 index.html（推荐，零依赖）
start index.html

# 方式二：本地静态服务（可选）
python -m http.server 8000
```

演示模式使用固定种子 `20261024` 与固定剧本，评委面前那一局每次完全一致。

## 目录结构

```
index.html            单页容器：#stage / #narrator / #hud / #modal / #decide / #bag / #btn-shop
style.css             暗色舞台风、木纹门、HUD 卡片、按钮五档层次、窄屏媒体查询
js/state.js           全局状态定稿（GameState 模板、createInitialState、可复现 RNG、CodexStore）
js/data.js            由 tools/build-data.js 从 data/*.json 内联生成（勿手改）
js/effects.js         applyEffect(state, effect, opts)：金币/怀疑值/耐心的唯一加减点
js/narrator.js        旁白取材、撒谎率、质疑判定、彩蛋与高光文案
js/ui.js              DOM 渲染与动画（Promise 接口，可跳过；含商店弹层、背包栏、WebAudio 音效/BGM、线索摘要、提词器、开奖光效与金币飞入）
js/game.js            状态机主循环（setState 集中切换，无 DOM 依赖，可无头运行）
data/*.json           内容源文件：items / shop / narrator / config / seed_demo
tools/build-data.js   生成 js/data.js（零依赖，node 内置模块）
tests/                无头自测与验收脚本：sim / shop / dom-smoke / headless-check / run-all / mutation-proof
assets/               素材占位（当前全部用 CSS 色块 + 内联 SVG + 文字，不引外链）
docs/                 协作说明、回滚说明、现场自测清单、商店与美术设计契约
```

浏览器侧不 fetch JSON（`file://` 下会被 CORS 拦住），所以内容以 `js/data.js` 的形式随页面一起加载；`data/*.json` 是可读、可评审的作者源文件，二者由 `tools/build-data.js` 保持同步。

## 操作

| 操作 | 说明 |
| --- | --- |
| 点门 | 选一扇门，主持人会替你打开一扇门（**绝不会开你选的那扇，也绝不会开大奖门**） |
| 长按门 | 窥视（每轮一次，只给模糊提示） |
| 坚持本门 | 决定最终翻开当前这扇门 |
| 换门 | 翻到另一扇没被打开的门：**有换门券就消耗券，否则扣 15 金币**；两者都没有则留在决策阶段 |
| 质疑旁白（验证线索） | 消耗 1 点怀疑值，**每轮只能质疑一次**；旁白有时会给出可验证的**线索**（「3 号门里是小奖」「大奖在 1 号门」…），质疑成功即拆穿谎言；连续成功有**连击**加成（+20 → +30 → +40，封顶 +40） |
| 加倍下注 | 本轮收益与负面效果 ×2，不可叠加 |
| 商店（右上角） | **决策阶段 / 本轮结算页**可开，金币买道具；买了自动进背包 |
| 背包 | 有道具时显示在舞台下方；点道具使用（仅决策阶段可点） |
| 提词器 | 地址后加 `?rehearsal=1`（或 `#rehearsal=1`）开启，右下角常驻提示「下一步该做什么」，演示时给自己看 |
| 键盘 | `1`/`2`/`3` 选门；`Q` 质疑、`D` 加倍、`S` 换门、`C` 收手；`M` 静音、`?`/`H` 规则、`,`/`.` 设置；弹层内 `空格`/`Enter` = 主按钮、`Esc` 关闭；输入框聚焦时不抢键 |
| 规则 / 设置（右上角） | 「规则」看五决策与快捷键；「设置」切旁白人格（毒舌 / 温柔 / 癫狂）、BGM 与音效开关、动画速度三档、清空本机数据 |
| 新手引导 | 首次进入自动弹 5 步气泡（选门 → 旁白 → 决策 → 商店 → 收手）；跳过或完成后不再出现，按 `?` 随时看规则 |
| 成就 / 统计 | 10 个成就与单机统计卡都在「看图鉴」里；统计记录局数、累计金币、最佳单局、最高轮次、质疑次数/成功数、结局数 |
| 种子分享 | 结算页显示 8 位种子并可「复制种子」；`index.html?seed=abc123` 可重放同一局（同种子发牌一致） |
| 收手 | 在决策阶段或本轮结算页均可，进入结算页 |
| 右上角 | 重置 / 演示模式切换 / 静音（WebAudio 现场合成，无音频文件；**重置或切换模式后仍保持静音**） / 跳过动画 |
| 结算页 | 「再来一局」重开一局；「看图鉴」查看收集进度与最佳成绩；结算页还会给出**结局**（如「全识破」「绝地翻盘」「被旁白 PUA」）与对应旁白点评 |

## 商店与背包（2026-10-24 第二轮新增）

赚到的金币不再是死数字：决策阶段可以开商店，把金币换成道具，道具进背包，需要时点一下就用。

| 商品 | 价格 | 限购 | 效果 |
| --- | --- | --- | --- |
| 换门券 `switch_ticket` | 25 | 3 | 换门时自动顶上，省下 15 金币 |
| 闭嘴卡 `mute_card` | 20 | 2 | 使用后**下一轮**旁白沉默（防剧透，不防霉运） |
| 双倍金币 `double_coins` | 40 | 2 | 本轮开奖收益 ×2，罚金也 ×2（等价于「加倍」） |
| 保险丝 `fuse` | 35 | 2 | 接上后下一次负面结算归零，用掉即烧断 |
| 神秘盒 `mystery_box` | 15 | 不限（每买一次当场开一次） | 当场开：小奖（+30）或小坑（−15），期望值略亏，手气自己扛 |
| 续命符 `patience_charm` | 60 | 2 | 立刻 +1 点耐心（上限 5） |

经济规则：换门不再免费（无券扣 15 金币，`data/config.json` 的 `economy.switchCost`）；商店只在 `DECIDE` / `SETTLE_ROUND` 两个相位可开；消费金额累计进 `state.spentCoins`，结算页会多出一行「商店消费」；买过的件数记在 `state.shopBuys`。所有金钱变动仍然只经过 `js/effects.js` 这一个加减点。


## 第三轮：新玩法与表现（2026-10-25 凌晨）

「别信旁白」不再是一句口号：旁白现在会给出**可验证的线索**，你可以在质疑时验证它；质疑成功会**连击**，空门/小奖会**回一点怀疑值**，结算时还会根据你的打法给出**结局**。

| # | 内容 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| F1 | **线索制质疑**：13 条 claimable 旁白会附「3 号门里是小奖 / 大奖在 1 号门 / 你手里的是陷阱」等线索；`resolveChallenge` 有线索时判定 = 线索真假，不再掷骰子；旁白面板显示「线索：…」摘要 | `data/narrator.json`、`js/narrator.js`、`js/ui.js` | `tests/features.js` claim 组 |
| F2 | **连击 + 怀疑值恢复**：连续质疑成功金币 +20/+30/+40（封顶 +40）；空门与小奖各回 1 点怀疑值、上限 3，让「验证线索」可持续使用 | `data/items.json`、`data/config.json`、`js/effects.js`、`js/game.js` | `tests/features.js` 连击/怀疑值组 |
| F3 | **语录扩容 + 图鉴可达**：旁白 24 → 60 条（`endings` 另有 16 条），8 种结局称号；`_playLine` 播出即解锁，图鉴不再有「永远拿不到」的语录 | `data/narrator.json`、`js/game.js`、`js/state.js` | `tests/features.js` 图鉴组 |
| F4 | **多结局**：`computeEndingId()` 按优先级判定 8 种结局（全识破 > 绝地翻盘 > 稳如老狗 > 见好就收大师 > 被旁白 PUA > 欧皇候选 > 反杀旁白 > 普通赌徒），结算弹层多出「结局」行与旁白点评 | `data/config.json`、`js/game.js`、`js/ui.js` | `tests/features.js` 结局矩阵 |
| F5 | **演示层**：提词器（`?rehearsal=1`，纯浮层不占布局）、低频 BGM（按轮次升调、静音即停）、开奖金/红大光效、金币飞入 HUD、结算「结局」行；全部走 WebAudio 现场合成，零音频文件 | `js/ui.js`、`style.css`、`js/game.js` | `tests/dom-smoke.js` 结构契约 + Fake AudioContext 计数 |

同轮顺带修掉的缺陷：①**`picked_kind` 线索补生成**（引擎先播旁白后选门，原实现无法引用玩家所选门）；②**图鉴语录可达**（此前 14/24 条永远拿不到）；③**质疑按钮 title** 改为「质疑 / 验证线索」；④上一轮评审要求的门卡 `max-height/aspect-ratio` 与 667×375 裁切在本轮仍在（F5 的光效/金币飞同样受 `prefers-reduced-motion` 约束）。



首次获得的物品、首次听到的旁白话术、结算解锁的结局称号会写入**本机浏览器**的 `localStorage`，键名固定：

- `three_doors_codex_v1`：物品图鉴 / 语录图鉴 / 结局称号
- `three_doors_best_v1`：最佳金币、最高轮次、已解锁称号

图鉴弹层里的「清空收集进度」会同时清掉这两个键。存档只存在本机、不上传；隐私模式、配额不足或存档损坏时**静默降级为空图鉴**，不会白屏、不会中断演示。

## 第四轮：体验增强（G1–G8）

更完整、更有意思、更好看、更易上手：新手引导、键盘全操作、三种旁白人格、成就与统计、种子分享、美术升级、竖屏提示。零新增依赖、零外部资源。

| # | 内容 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| G1 | **新手引导**：首局自动 5 步气泡（`选门 → 旁白 → 决策 → 商店 → 收手`），按锚点高亮对应控件，可跳过/完成；`?` 随时重看规则；引导中进入结算相位会自动收尾 | `index.html`、`js/ui.js`、`js/game.js` | `tests/ux.js` 引导组 |
| G2 | **键盘全操作**：`1/2/3` 选门，`Q` 质疑、`D` 加倍、`S` 换门、`C` 收手、`M` 静音、`?`/`H` 规则、`,`/`.` 设置；弹层 `空格`/`Enter` 主按钮、`Esc` 关闭信息弹层（**必选流程的本轮结算/结算页/结束页不响应 Esc**，必须点按钮，避免关掉后卡在无弹层状态）；与鼠标点击走同一条 action 通道 | `js/ui.js` | `tests/ux.js` 键盘组（X4.7 / X4.7b） |
| G3 | **旁白人格**：毒舌 / 温柔 / 癫狂三档，撒谎率增量 `0 / −0.05 / +0.05` 并夹在 `config.personalities.lieRateDeltaCap`（0.1）内；每档有独立 intro/flavor/settle 台词池，设置弹层可切、旁白面板与右下徽标显示当前人格 | `data/personas.json`、`js/narrator.js`、`js/ui.js` | `tests/ux.js` 人格组 |
| G4 | **成就 10 条**：`见好就收 / 五关斩将 / 三百门客 / 三连问 / 全知者 / 剧作人 / 梭哈 / 绝地反击 / 火眼金睛 / 千人千面`，判定类型各一（收手/轮次/金币/质疑连击/语录/结局/加倍/翻盘/零失误/人格），图鉴里以成就墙展示 | `data/achievements.json`、`js/game.js`、`js/ui.js` | `tests/ux.js` 成就组 |
| G5 | **统计档案**：`three_doors_stats_v1` 记录局数、累计金币、最佳单局、最高轮次、质疑次数/成功数、解锁结局数；「看图鉴」里的统计卡展示 | `js/state.js`、`js/game.js`、`js/ui.js` | `tests/ux.js` 统计组 |
| G6 | **种子分享与重放**：结算页显示 8 位种子、可复制；`?seed=xxxx` 重放同一局（优先于演示模式与 `?rehearsal=1`）；同种子发牌一致 | `js/game.js`、`js/ui.js` | `tests/ux.js` 种子组 |
| G7 | **美术升级**：幕布 + 聚光灯 + 暗角、门卡浮雕/把手/质感/悬停微倾、标题艺术字、HUD 内联 SVG 图标、开奖彩带（≤1.2s 清理，`prefers-reduced-motion` 下不生成）、按钮质感 —— 纯 CSS + 内联 SVG，无外链 | `style.css`、`js/ui.js` | `tests/ux.js` 结构组 + 对比度/布局静态表 |
| G8 | **竖屏提示**：视口高 < 400px 时显示「建议横屏体验」浮层，恢复横屏自动隐藏 | `index.html`、`js/ui.js` | `tests/ux.js` 竖屏组 |

同轮顺带：结算弹层新增**旁白点评行**（引擎写 `state.settleLine`，UI 渲染 `.settle-line`，本轮/收手/劝退三种时刻各有专属台词）；`apply_speed` 动作与 `set_pref{animationSpeed}` 等价；设置弹层与规则弹层不再误显示「种子」行。

## 本地校验

```powershell
node tools/build-data.js          # 重新生成 js/data.js（应与提交内容一致）
node tools/build-data.js --check  # 只校验 data/*.json 与 js/data.js 是否同步
node tests/sim.js                 # 无头逻辑 + 清单验收项（175 项）
node tests/shop.js                # 商店 / 背包 / 经济 / 换门代价（75 项）
node tests/features.js            # 线索 / 连击 / 怀疑值 / 结局 / 提词器 / 图鉴可达（58 项）
node tests/ux.js                  # 体验增强：成就 / 统计 / 种子重放 / 键盘 / 人格 / 引导 / 竖屏（73 项）
node tests/dom-smoke.js           # Node DOM 垫片：页面结构、商店 DOM 契约、六档视口、WCAG 对比度（98 项）
node tests/run-all.js             # 全量自测，7 个套件：488 PASS / 0 FAIL / 9 SKIP
node tests/mutation-proof.js      # 变异自证：25/25（故意改坏数据/逻辑，确认自测真的会红）
```

`tests/run-all.js` 默认第一项就是 `tools/build-data.js --check`（防「改了 `data/*.json` 忘了重建 `js/data.js`」的假绿）；`STRICT=1 node tests/run-all.js` 会把 SKIP 视为失败（最终验收用）。浏览器端到端用例（`tests/headless-check.js`）在无法启动浏览器的环境里会 SKIP，并在汇总表里逐条点名。仓库用 `.gitattributes` 把文本文件固定为 LF，且 `--check` 比较前会归一化换行，所以 Windows 上 `core.autocrlf=true` 不会让 `run-all` 假失败（换行差异不判为产物漂移，数值/文案漂移照旧判失败）。

演示前 30 分钟的手工自测步骤、固定剧本的三轮预期结果与备用方案见 [现场自测清单](docs/现场自测清单.md)。

## 验收对照（对应《开工清单》阶段 0–7）

| 清单阶段 | 落地位置 | 证据 |
| --- | --- | --- |
| 0 骨架与状态定稿 | `js/state.js`、`js/game.js`（状态机 10 态） | `node tests/sim.js` 阶段 0 组 |
| 1 单轮闭环 | `js/game.js` generateDoors / hostPick / chooseDoor / reveal | 阶段 1 组：门面不变量、主持人开门规则 |
| 2 资源与质疑 | `js/effects.js`（唯一加减点）、`js/narrator.js`（撒谎率 / 记仇 / 质疑判定） | 阶段 2 组：九种物品结算、质疑成败 |
| 3 连续闯关与收手 | `js/game.js`（跨轮继承、风险提示、DECIDE/SETTLE_ROUND 双收手、评级档位） | 阶段 3 组：评级 0–99 / 100–199 / 200–299 / 300+ 与「见好就收大师」 |
| 4 双模式与固定种子 | `DEMO_SEED = 20261024`、`data/seed_demo.json` 三轮剧本、普通模式时间种子、一键重置 | 阶段 4 组：固定种子多次结果一致、重置 ≤1 s |
| 5 图鉴与本地存档（P1） | `CodexStore`（`js/state.js`）+ 结算页「看图鉴」 | 阶段 5/6 组：落盘键名、读回、清空、坏存档降级 |
| 6 演示保障 | 全本地资源、可跳过动画、旁白截断、HUD 娱乐声明 | 阶段 6 组：无外链、连点 50 次、跳过照常结算 |
| 7 演示前自测 | —（人工流程） | [现场自测清单](docs/现场自测清单.md) |

## 本轮评审修复（2026-10-24）

三份外部评审（玩法数值 / 表现层 / 测试工程化）加 Lead 独立复核后，按批准范围落地 **8 项修复（4 个 P0 + 4 个 P1）**，另含 2 项在修 P0 时顺带发现的附带修复。每项都有可复现证据，命令见「本地校验」。

| # | 修复 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| 1（P0） | **剧本门位也过硬不变量**：主持人绝不打开玩家所选的门或大奖门；剧本槽位不合法时退化为 `hostPick`（留痕 `state.hostScriptFallback`） | `js/game.js` | `tests/sim.js` G8.1/G8.1b/G8.1c |
| 2（P0） | **质疑每轮一次**：同一轮第二次质疑直接被拦并提示，金币不变（此前撒谎轮可连点刷 +20） | `js/game.js` | `tests/sim.js` CHALLENGE-ONCE |
| 3（P0） | **轮次横幅去剧透**：`roundHints` 与兜底文案不再出现「哪轮旁白说真话 / 哪轮撒谎」 | `data/config.json`、`js/game.js` | `tests/sim.js` HINT-NO-SPOILER |
| 4（P0） | **「静音」变成真开关**：WebAudio 现场合成的提示音（零音频文件、离线可用、`gain ≤ 0.05`、单音 ≤ 0.2s）；`muted` 时零发声 | `js/ui.js` | 34 项 Fake AudioContext 动态校验 |
| 5（P1） | **门卡高度上限**：`max-height` + 矮视口媒体查询，修掉 667×375 / 640×360 下门卡底部被裁 | `style.css` | 七档静态推算表（见评审报告） |
| 6（P1） | **测试去假绿**：`run-all` 默认先跑产物一致性校验；5 处恒真断言换成真断言（含「离线可跑」静态证明）；新增变异自证脚本 | `tests/**` | `node tests/mutation-proof.js` 13/13 |
| 7（P1） | **文档门号 off-by-one**：屏上门号 = `slot + 1`，文档此前按 0 基写成「2 号门」 | `README.md`、`docs/现场自测清单.md` | 与 `data/seed_demo.json` + `js/ui.js` 对齐 |
| 8（P1） | **`main` 指向已验证提交**：此前 `main` 只有文档，按 README 拉下来打不开页面 | git 分支指针 | 回滚点分支 + `git log` 关系 |
| 附 1 | **静音跨重置/切换模式保持**（修 4 时发现的尾巴）：静音是本机偏好，不是本局状态 | `js/game.js` | `E:\dsh3\lead_mute_check.js` 10/10 |
| 附 2 | **文案一致**：主持人台词不再断言「打开的是空门」（剧本会故意开炸弹/陷阱） | `js/ui.js` | 文案审校 |

## 第二轮：商店 / 美术 / 测试加固（2026-10-24 晚）

在原有 8 项修复之上，本轮解决「金币无处可花」与「界面过于朴素」两件事，口径与上一轮一致：每项都有可复现证据。

| # | 内容 | 涉及文件 | 证据 |
| --- | --- | --- | --- |
| N1 | **商店与背包**：右上角「商店」在 DECIDE / SETTLE_ROUND 可开，6 件商品含限购；买不起 / 已满 / 未知 id / 相位不对四类拒绝；背包点道具使用 | `index.html`、`js/state.js`、`js/game.js`、`data/shop.json`、`js/ui.js` | `tests/shop.js` 75/75、`tests/dom-smoke.js` U10.* |
| N2 | **换门不再免费**：无券换门扣 15 金币（`economy.switchCost`），换门券才真正有价值 | `js/game.js`、`data/config.json` | `tests/shop.js` SH4.* |
| N3 | **四件道具生效**：保险丝（抵一次负面）、双倍金币（本轮 ×2）、续命符（+1 耐心，上限 5）、神秘盒（当场开，小奖/小坑） | `js/game.js`、`js/effects.js` | `tests/shop.js` SH3.* / SH5.* / SH6.* |
| N4 | **修掉换门两处真缺陷**（qa-verify 报，Lead 修，qa-verify 独立复验）：① `_apply` 会替换 `Game.state`，旧实现把 `pickedSlot` 写回旧对象 → 扣了 15 金币却没换门；② 换门失败时被拖进 REVEAL，未留在 DECIDE | `js/game.js` | `tests/shop.js` SH4.2 / SH4.5 / SH4.12、`lead_shop_check.js` 91/91 |
| N5 | **美术升级**：木纹门 + 金属框 + 铭牌把手 + 3D 掀门、舞台聚光与暗角、HUD 卡片化、按钮五档层次、旁白气泡尾巴与打字机光标、大奖彩带；`prefers-reduced-motion` 下停装饰动画 | `style.css`、`js/ui.js` | `tests/dom-smoke.js` 对比度 49/49、六档视口静态推算全过 |
| N6 | **测试工程化加固**：新增 `tests/shop.js`（75 项）、`tests/mutation-proof.js` 扩到 19/19；并修掉 dom-shim 的 `innerHTML` 只存不解析（商店卡片在垫片里根本不存在） | `tests/**` | `node tests/run-all.js` 357 PASS / 0 FAIL / 9 SKIP |

> 本轮仍未引入任何外部依赖、外部字体或网络请求：音效是 WebAudio 现场合成，图标是内联 SVG，美术是纯 CSS。

## 已知偏差与取舍（评审请看这里）

1. **主持人开门的边界（硬不变量优先于剧本）**：任何模式下主持人都**不得打开玩家所选的门、不得打开大奖门**（`js/game.js` `chooseDoor` 统一校验）。① 普通模式：存在未选空门时优先空门（`hostPick`）。② 演示模式：剧本 `hostOpensSlot` 优先，但同样要过硬不变量——不满足时（例如玩家恰好点了剧本指定的那扇门）自动退化为 `hostPick`，并在 `state.hostScriptFallback` 留痕。按**屏上门号**：第 1 轮开 3 号门（bomb，slot 2），第 2 轮开 1 号门（empty，slot 0）；第 3 轮剧本指定 1 号门（trap，slot 0），而本轮预期是直接收手，只有玩家先点门时主持人才会开。这与清单「主持人打开一扇空门」字面表述的差异只存在于演示剧本（那是阶段 4 逐字写死的戏剧安排），普通模式始终走 `hostPick`。演示三轮剧情与结果（小奖 → 质疑反杀 → 收手结算）与清单一致。
2. **演示模式收手称号**：评级里「见好就收大师」要求 `round ≥ 4 且 coins ≥ 200`（`config.cashoutMaster`），而固定剧本只演 3 轮，所以演示收手时的称号是「欧皇候选（200–299 金币）」，不是「见好就收大师」。这是配置与剧本长度决定的，非缺陷；想现场展示大师称号可在第 3 轮结算后选「继续下一轮」再收手。
3. **浏览器真机渲染未自动化**：本仓库的自测在 Node 中运行（`tests/sim.js` + Node DOM 垫片 `tests/dom-smoke.js`）。开发沙箱无法启动浏览器子进程（Edge mojo 管道被禁），因此真机渲染、控制台报错、断网这三项按清单阶段 6/7 由人工自测覆盖：见 [现场自测清单](docs/现场自测清单.md)。`node tests/run-all.js` 在浏览器不可用时会把该套件标为 SKIP 而不是失败。
4. **`rewardMode` 切到 `hint` 会剧透**：`js/narrator.js` 在 `suspicion.rewardMode === 'hint'` 时会输出「真话：第 N 扇门里是大奖。」。当前 `data/config.json` 配的是 `'coins'`，走不到该分支；若改成 `'hint'`，横幅去剧透的保证就会被这条台词破坏。这是刻意的奖励模式开关，保留但默认不启用。
5. **图鉴存档键无版本迁移**：`three_doors_codex_v1` / `three_doors_best_v1` 是 v1 固定结构，读到损坏或不兼容的 JSON 时静默降级为空图鉴（不白屏、不中断演示）；后续若改结构需升键名。
6. **换门有代价，演示剧本不经过付费换门**：普通模式下无券换门要扣 15 金币（`economy.switchCost`），所以「换门恒为正收益」不再成立——这是为了让换门券有意义。固定种子的自动演示走「坚持本门 + 质疑反杀」，不触发换门，因此三轮金币仍是 130 → 250 → 250 收手（`E:\dsh3\lead_smoke.js`）。**若演示时手动点「换门」而不带券，会扣 15 金币、结局数字随之变化**；现场请让自动演示跑完。
7. **闭嘴卡改为「下一轮」生效**：这张卡在决策阶段使用，而本轮旁白早就念完了，「本轮闭嘴」实际永远拦不到旁白。实现改为沉默下一轮旁白，`narrate()` 消费后立即清空（用完即失效，不会跨轮残留）。
8. **即时道具的限购用 `state.shopBought` 计数**：神秘盒 / 续命符是「买下即结算」、不进背包，用背包计数做限购会永远算 0（→ 无限买）。因此即时商品按「本局买过几次」计数；`cap: null`（神秘盒）解释为不限购，`cap: 2`（续命符）为真正的一局两次；耐心已满时续命符直接拒绝购买，不让玩家花 60 金币买一次空操作。
9. **`#vignette` 由 `js/ui.js` 自建**：设计契约把它列在 `index.html` 里，但装饰层归渲染层所有；`js/ui.js` 检测到缺失就创建一个（幂等，二次渲染不会重复插入）。所以 `index.html` 里没有这个标签是**有意**的，不是遗漏。
10. **线索只来自旁白**：只有 13 条 claimable 旁白附带可验证线索（`slot_kind` / `big_prize_in` / `picked_kind`）；没有线索时质疑仍走原有的撒谎率掷骰，不产生新的信息通道。线索按 `state.doors` 实时计算，绝不引用主持人已打开的门。
11. **演示三轮的结局与称号不同源**：固定剧本 3 轮、质疑成功 1 次、耐心全程没掉，所以结局是「稳如老狗」（`iron_patience`：`round ≥ 3` 且耐心未下降），称号是「欧皇候选」（250 金币）。称号看金币、结局看打法，两者本来就可以不同；想演「全识破」需要一局内质疑成功 3 次且零失败。
12. **提词器与 BGM 都是纯前端、零资源**：提词器用 `?rehearsal=1`（或 `#rehearsal=1`）开启，是 `position:fixed` 浮层、`pointer-events:none`，不占布局也不吃点击；BGM 由两个 oscillator 现场合成（按轮次升调 ~100/130/160 Hz，`gain ≤ 0.03`），没有音频文件，静音 / 非对局 / 页面隐藏即停。
13. **新玩法数值都在配置里**：怀疑值上限 `config.suspicion.max`（3）、连击步长/封顶 `comboStep`/`comboCap`（10/20）、8 种结局的判定与优先级在 `config.endings`，改数值不用改代码，改完跑 `node tools/build-data.js` 重建即可。
14. **成就阈值以数据为准**：`data/achievements.json` 的 `check.type`（`cashouts/rounds/coins/challengeWins/codexLines/endings/doubles/comeback/clean/personas`）与 `threshold` 是唯一事实来源；`js/game.js` 的 `ACH_CHECK` 同时兼容契约 v4 里的旧类型名（`cashout/combo/all_in/...`），未知类型一律视为「不满足」而不是抛错。
15. **旁白人格只影响台词与撒谎率**：`lieRateDelta` 叠加后夹在 `±config.personalities.lieRateDeltaCap`（0.1）内；人格不改变状态机、不改变物品权重、不改变主持人的硬不变量。
16. **结算点评行由引擎写入、UI 渲染**：引擎在「本轮结算 / 收手 / 耐心归零」时把台词写进 `state.settleLine`，`js/ui.js` 的 `settleRow()` 渲染 `.settle-line`（body 里已有同句则跳过）。headless 测试只断言 `state.settleLine` 与弹层 kind，不依赖 DOM。
17. **`?seed=` 会强制普通模式**：`index.html?seed=xxxx` 优先于 `?rehearsal=1` 与演示模式，用于「重放刚才那一局」；演示模式想复现固定剧本请不带 `?seed=`。
18. **首帧渲染与真机目检**：G7 的视觉升级（幕布 / 聚光灯 / 浮雕门卡 / 彩带）全部是静态 CSS + 内联 SVG + 运行时合成，没有音频或图片文件；与第 3 条相同，沙箱无法启动浏览器，**真机观感需要人工按 [现场自测清单](docs/现场自测清单.md) 第 13 节看一遍**。
19. **Esc 不关必选流程弹层**：本轮结算（`round`）/ 结算页（`cashout`）/ 结束页（`gameover`）三种弹层必须点按钮才能离开；按 Esc 会被忽略（契约 §4.2 注）。原因：这些弹层一旦被关掉、而相位仍停在 `SETTLE_ROUND / CASHOUT / GAME_OVER`，玩家会卡在「无弹层可操作」的死状态。信息弹层（规则 / 设置 / 图鉴 / 商店）一律可用 Esc 关闭；`Game.openHelp/openSettings` 也会拒绝覆盖这些必选弹层（只弹 toast）。
20. **新手引导是 5 步，不是契约初稿的 3 步**：`Game.tutorialSteps()` 返回 5 步（`tut_door/tut_narrator/tut_decide/tut_challenge/tut_cashout`），每步带 `id/title/text/anchor`，anchor 覆盖 `doors/decide/cashout`；契约 §2.3 已按实测回写。步数多不是缺陷，是「把商店/收手也说清楚」的取舍。
21. **测试基线数字**：`node tests/run-all.js` = 7 套件 **488 PASS / 0 FAIL / 9 SKIP**（`build-data --check` 独立一项、sim 175、shop 75、features 58、ux 73、dom-smoke 98、headless 9 PASS + 9 SKIP）；`STRICT=1` 会把 9 条 SKIP 判失败（全部是 headless-check 的 Edge 启动项）。`tests/ux.js` 的「只提示一次」断言依赖 `tests/dom-shim.js` 的 localStorage 桩记录 `_writes`（本轮给 `makeStorage()` 补上）。

## 开发约定

- `main` 保存团队集成版本。
- 每个任务使用独立分支，例如 `feature/<成员>-<功能>`、`fix/<成员>-<问题>`；本对话使用 `codex/<任务>`。
- 每个可独立说明的改动单独提交，完成相应检查后推送，通过 Pull Request（PR）协作。
- 每个阶段保留提交编号；重要改动开始前和里程碑完成后建立远端回滚点。
- 回滚共享代码时优先使用 `git revert` 产生撤销提交，保留其他成员的工作和提交历史。

详细操作见 [协作说明](CONTRIBUTING.md)、[回滚说明](docs/ROLLBACK.md)。自动化开发须遵守 [AGENTS.md](AGENTS.md)。

## 初始回滚点

`checkpoint/2026-10-24-initial`：仅包含仓库文档和 Git 基础配置，不代表应用已经可运行或通过测试。该分支创建后固定保留，不继续开发、不移动。

## 队员加入

仓库所有者在 GitHub 仓库的 **Settings → Collaborators** 中邀请队员的 GitHub 账号；队员接受邀请后，使用各自账号和任务分支协作。公开可查看不等于拥有推送权限。

## 免责声明

游戏内金币纯属娱乐，非真实货币，不涉及任何充值、提现或赌博表达。
