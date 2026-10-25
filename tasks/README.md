# 三份任务交接包（2026-10-25）

本目录是给三名执行者的**自包含任务书**，纯文本（无二进制），可直接通过 GitHub 上传/分享：

| 文件 | 执行者角色 | 交付物 |
|---|---|---|
| `任务A_界面与美术.md` | 前端/视觉/动效工程师 | `js/ui.js` + `style.css` |
| `任务B_数据与概率.md` | 数值/数据层工程师 | `data/**` + `tools/build-data.js` + `js/narrator.js` + `js/effects.js` + `js/data.js`（生成） |
| `任务C_质量与测试.md` | 测试/质量工程师 | `tests/**`（新增套件 + E2E + 性能 + 变异扩展） |

## 发给执行者的第一句话（可直接复制）

> 你是《三扇门：别信旁白》项目的<角色>。请先完整阅读任务书（本文件对应的 md），再按其中"验收命令"逐条自测后提交交付物。仓库：`https://github.com/gnbfp/heikesong`，分支 `codex/stage0-1-vertical-slice`。若无法访问仓库，请使用你本地同结构的项目副本。**不要修改任务书范围以外的文件。**

## 三条铁律

1. **不许引入新依赖/外链/构建链**：项目是零构建、双击 `index.html` 即玩的静态站。
2. **不许让测试退化**：`node tests/run-all.js` 必须 exit 0（基线 514 PASS / 0 FAIL / 9 SKIP）。
3. **交付必须含 `交付说明.md` + `files/` 目录**（与仓库相对路径一致的完整文件副本）。

## 整合方式（Lead 负责，已工具化）

> `handoff/integrate.js` 是整合者（Lead）工作区里的工具，不在本仓库内；执行者无需关心，只需交付产物目录。

执行者完成后，把产物的**目录**交给 Lead 即可（zip 或源码树均可）。Lead 执行：

```bash
# 1) 结构 + 写作用域校验 + 沙箱演练（不会碰真仓库）
node handoff/integrate.js --dir <交付目录> --scope a|b|c

# 2) 演练通过后写回仓库
node handoff/integrate.js --dir <交付目录> --scope a|b|c --apply

# 3) 重新生成数据产物 + 全量回归
node tools/build-data.js
node tests/run-all.js

# 4) 通过后：分层提交 → 推送 → 新 checkpoint 分支 → 重新打队员包
```

规则：**非交互、无命令替换执行**；校验失败只报错不写盘；路径逃逸（`../`、绝对路径、符号链接）一律拒绝；写回前先备份原文件（`<file>.bak`）。三份交付到齐后由 Lead 依次合并、跑 `run-all` 与 `mutation-proof`，全绿才提交推送；任何一份失败即整体回滚（`git checkout -- .`）并回报。

## 与仓库现有资产的衔接

- 设计契约：`docs/设计契约_专业级打磨_v5.md`（新功能先在契约里加一节，再动代码）
- 评审：`docs/评审_功能扩展与改进_2026-10-25.md`（本次新增功能的来源与优先级）
- 演示/自测：`docs/现场自测清单.md`
- 回滚：`checkpoint/2026-10-25-pro-polish-3cef1e0`
