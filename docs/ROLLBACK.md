# 回滚说明

## 回滚点的含义

提交 SHA 精确标识一版已提交的文件。重要阶段使用唯一的命名回滚点，并将其同步到 GitHub。

当前通过 `checkpoint/YYYY-MM-DD-<说明>` 远端分支保留回滚点。分支创建后固定指向该提交，不继续开发、不移动、不删除。它依靠团队约定保留，目前未配置防修改保护。

首次回滚点 `checkpoint/2026-10-24-initial` 只包含协作文档与 Git 配置，检查范围为文件内容和引用一致性；没有应用功能测试。

## 创建回滚点

先确认工作区状态、所选提交以及实际验证范围。以下占位符必须替换成已核对的具体值：

```sh
git status
git fetch origin
git show --stat <已核对的提交SHA>
git branch checkpoint/YYYY-MM-DD-description <已核对的提交SHA>
git push origin checkpoint/YYYY-MM-DD-description
```

名称已存在时选择新名称，不覆盖已有回滚点。创建后核对远端分支的 SHA，并在 PR 或交付说明中记录：名称、提交 SHA、用途、验证结果。

普通 Git 推送可用时也可创建并推送附注标签。当前连接的 GitHub 插件没有创建标签的入口，因此初始化使用上述远端分支。

## 查找或查看旧版本

```sh
git fetch origin
git branch -r --list 'origin/checkpoint/*'
git log --oneline --decorate origin/main
git show --stat origin/checkpoint/2026-10-24-initial
```

若需要运行或检查旧版本，先保存未提交工作，再从回滚点建立独立恢复分支：

```sh
git switch -c recovery/inspect-initial origin/checkpoint/2026-10-24-initial
```

这一步创建旧版本的工作分支，不会撤销远端 `main` 的提交。

## 撤销已进入主分支的错误

先核对有问题的提交、后续依赖和队员改动。为具体错误创建撤销提交：

```sh
git switch -c fix/revert-specific-change origin/main
git show <错误提交SHA>
git revert <错误提交SHA>
# 执行项目对应的检查
git push -u origin fix/revert-specific-change
```

然后提交 PR 并按团队流程合并。若错误来自合并提交，必须先核对父提交，再考虑 `git revert -m 1 <合并提交SHA>`；不能对普通提交套用该参数。若出现冲突，检查相关改动后解决；放弃本次撤销可用 `git revert --abort`。

避免直接批量撤销“回滚点之后的全部提交”，其中可能包含队员正确的工作。需要恢复整版时先评估受影响的改动，再制定恢复提交。

Git 仅恢复已提交的仓库文件；数据库迁移、外部服务状态和未提交文件需要单独处理。共享分支不使用 `reset --hard` 或强推回滚。
