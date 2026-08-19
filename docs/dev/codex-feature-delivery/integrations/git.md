# Git 集成规范

本文定义 v2 当前实现如何把 Feature、Evidence 和 Decision 绑定到 Git 对象。它是 Git adapter，不改变 [HANDBOOK.md](../HANDBOOK.md) 中的平台无关 Gate 语义。

## 1. 版本身份

- repository identity 来自项目的 `.feature-delivery/repository-registry.yaml`；`managed` 是项目根内登记路径，`external` 是显式登记的单层项目外 checkout，相邻路径只有登记后才成立；
- baseline 使用完整 commit SHA，不使用浮动分支名或 tag；
- G3/G4 `code_refs` 对每个 repository 同时记录 `code_sha` 与 `base_sha`；
- 契约、生成物和 release artifact 另有自己的 digest，不能只靠 Git tag；
- 包含 Decision 的治理提交不要求引用自身 SHA，以避免自引用。

## 2. Changed-files 覆盖

base/head 模式要求 target base 是 candidate head 的祖先。变更集合使用：

```text
merge-base(target base, candidate head)...candidate head
```

`merge-base` 只决定 diff 范围，不能替代 G2 授权绑定的当前 target base。

沿无 merge 的 first-parent 路径，最后一个修改 Feature root 外普通文件的提交记为 implementation commit `C`。`C` 之后只能追加 evaluator 识别的 Feature Package 管理文件，且 candidate head 的普通路径 tree 必须与 `C` 一致。G3/G4 绑定 `C`；后续签名账本提交不会造成 head SHA 自引用。纯 Package metadata 变更的 `code_sha` 为 `null`。

报告必须区分：

- `target_base_sha`：受保护目标分支当前基线；
- `diff_base_sha`：用于计算变更集合的 merge base；
- `head_sha`：候选提交；
- `code_sha`：实际实现提交，或 metadata-only 时的 `null`。

## 3. 路径覆盖

每个普通实现路径必须同时追溯到：

1. 当前 Feature Package；
2. G2 Authorization 的 repository、path 与 target-base ref；
3. 命中最具体 Slice scope 的有效 G3；
4. 项目 policy 要求时的有效 G4。

Feature Package 内只允许 core 文件和 `feature.yaml.artifacts[].path` 声明的文件。未声明路径、重复 `feature.id`、绝对路径、`..`、空段、反斜杠和 glob 一律拒绝。

## 4. Append-only 历史

base/head 验证必须按 target base 到每个后续 commit 的顺序检查 `evidence.yaml` 与 `decisions.yaml`：

- ledger root identity 不变；
- entries 不得缩短；
- 旧 entry 的 canonical 值不得改变；
- 只允许尾部追加。

因此“先追加、下一提交再改写”同样失败。该历史保护先于 exemption。

## 5. Base-trusted 读取

远端合并门禁必须从受保护 target-base Git tree 读取 verifier、Schema、Gate Policy、changed-files policy 和 approval trust root。读取路径使用 lexical repo-relative 语义，并拒绝 symlink、tree 和 submodule mode；不得使用候选 worktree 的 `realpath` 改变信任源归属。

候选 head 只能作为 Git objects 解析，不得 checkout 后执行其中的脚本。候选 ref 必须与平台事件声明的精确 head SHA 一致。

## 6. 治理 TCB

治理 TCB 至少包括：

- CI adapter；
- framework scripts、schemas 和依赖锁；
- active/versioned Gate Policy；
- changed-files policy；
- approval trust root；
- repository registry；
- legacy pin registry。

TCB 变更必须隔离，且除普通代码审查外，还要由待审分支不可写的第二通道批准精确 change-set digest。候选 head 不能用自己新增的 policy、key 或 verifier 给自己放行。

## 7. 本地诊断与远端强制

本地显式文件列表只用于诊断。它不能证明完整提交历史、受保护 base、append-only 前缀或远端 required status，因此不能替代 base/head 合并门禁。

GitHub 实现见 [github-actions.md](github-actions.md)。其他平台的 adapter 必须实现相同的版本绑定、base trust、历史保护和 fail-closed 语义。
