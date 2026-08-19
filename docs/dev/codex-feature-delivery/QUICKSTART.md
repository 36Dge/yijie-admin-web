# 快速开始：创建第一个 v2 Feature Package

本页从已经初始化的项目开始。若 `<PROJECT_ROOT>/.feature-delivery.yaml` 或 `<FRAMEWORK_ROOT>` 尚不存在，先按 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md) 从 `<DISTRIBUTION_ROOT>` 原子初始化；不要预先人工复制 Framework。初始化后，以下占位符均来自项目配置：`<FRAMEWORK_ROOT>`、`<FEATURE_ROOT>`、`<PROJECT_ID>`、`<REPOSITORY_ID>` 和 `<ACTOR_ID>`。

## 0. 确认项目已接入

确认初始化已使用 Node.js 24–26，并且发行源和项目内 Framework 都在各自目录中通过 `(cd "<PATH>" && npm ci --ignore-scripts)` 安装。若选择了 `--ci github`，初始化器只生成候选 adapter 文件；GitHub App、Environment、variables、required status 和 branch protection 仍必须由管理员另行配置，见 [integrations/github-actions.md](integrations/github-actions.md)。

## 1. 管理员建立审批信任根

在 Codex 和待审代码不可访问的受保护终端或审批面生成 key。私钥绝不能提交进项目：

```bash
node <FRAMEWORK_ROOT>/scripts/init-approver-key.mjs \
  --actor <ACTOR_ID> \
  --key-id <KEY_ID> \
  --private-key <PROTECTED_PRIVATE_KEY_PATH> \
  --trust-root <PROJECT_ROOT>/.feature-delivery/approval-trust.yaml \
  --role accountable_owner \
  --role requirement_owner \
  --role technical_owner \
  --role reviewer \
  --gate G0 --gate G1 --gate G2 --gate G2C \
  --gate G3 --gate G4 \
  --profile standard \
  --target local_engineering \
  --valid-until <RFC3339_VALID_UNTIL>
```

示例 scope 只覆盖 `standard + local_engineering` 且止于 G4。G5/G6 应使用按职责和发布窗口收窄的 release-owner key。默认空 trust root 是有意的 fail-closed 状态。

首 key 和轮换属于治理 TCB 变更，必须经过项目 adoption 规定的包外第二通道；不能由候选变更新增 key 后自批。

## 2. 创建包

从目标项目 Git worktree 执行：

```bash
<FRAMEWORK_ROOT>/scripts/new-feature.sh \
  FEAT-001 task-history-export \
  --title "导出任务历史" \
  --owner <ACTOR_ID> \
  --scope <REPO_PATH>
```

Profile 和 Target 默认从 `.feature-delivery.yaml` 读取；只有本 Feature 需要偏离项目默认时才显式覆盖：

- `--profile lite|standard|controlled`：覆盖风险控制和文档深度；
- `--target local_engineering|staging|production`：覆盖生命周期终点。

`--scope` 是当前 repository 内的相对路径。若确实需要整仓范围，必须显式使用双重确认：

```bash
<FRAMEWORK_ROOT>/scripts/new-feature.sh \
  FEAT-001 task-history-export \
  --title "导出任务历史" \
  --owner <ACTOR_ID> \
  --scope . \
  --allow-root-scope \
  --root-scope-justification <REASON>
```

repository identity 必须与 `.feature-delivery/repository-registry.yaml` 一致。`managed` 是项目根内已登记路径；`external` 是显式登记的单层项目外 checkout。相邻 checkout 可以登记为 external，但未登记路径、隐式目录关系和多层项目外跳转不能获得身份。`repositories[].path`、`slices[].paths` 和 Authorization `paths` 始终表示对应仓库内部的相对范围，不写 checkout 的绝对路径。`controlled` 或高风险 G2 的整仓范围还要引用逐仓成功的 exception Evidence。

不要复制历史 v1 包。生成器会建立 v2 `feature.yaml`、append-only `evidence.yaml`/`decisions.yaml`，并按 artifact manifest 创建适用文档。

## 3. 验证骨架

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh \
  <FEATURE_ROOT>/FEAT-001-task-history-export
```

默认检查 Schema、policy、引用和产物一致性，不批准 Gate。尚未到期的模板变量不会阻塞早期 Gate；请求对应 Gate、使用 `--strict` 或将 lifecycle 改成 `completed` 后，全部到期文档必须完成。不要把 `not_run` 改成 `passed` 来消除错误。

## 4. 完成 G0

补齐：

- `00-feature-brief.md` 中的问题、价值、范围、非目标和 Owner；
- `feature.yaml` 中的 Profile、Target、仓库线索、数据分类和外部副作用；
- 初始未知项、调查权限和明确禁止的动作。

机器评估：

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh \
  --gate G0 <FEATURE_ROOT>/FEAT-001-task-history-export
```

`ELIGIBLE` 只表示可以送审。由有权人起草 `attestation: null` 的 Decision，在受保护审批面复核并签名：

```bash
node <FRAMEWORK_ROOT>/scripts/sign-decision.mjs \
  <FEATURE_ROOT>/FEAT-001-task-history-export \
  DEC-FEAT-001-G0-001 \
  --key-id <KEY_ID> \
  --private-key <PROTECTED_PRIVATE_KEY_PATH> \
  --trust-root <PROJECT_ROOT>/.feature-delivery/approval-trust.yaml
```

未签名记录只是草案。Codex 可以准备草案，不能读取私钥或替人运行签名。已签记录一经登记即 append-only；内容变化必须追加替代 Decision 并重新签名。

## 5. 只读调查与 Scope

可将以下任务交给 Codex：

```text
目标：为 FEAT-001 建立实现前事实，不修改文件，不访问真实数据，不触发外部写。

读取项目指令与仓库文档，检查 Git 状态，定位入口、测试、契约、数据、consumer
和发布控制面。输出 Fact / Assumption / Unknown，并记录：
1. 每个仓库的完整 HEAD、已有改动、baseline 命令与真实结果；
2. producer/consumer/数据/权限/外部系统 Boundary；
3. Feature size、依赖、关键路径与拆分结论；
4. contract、migration、安全、AI、费用与不可逆风险；
5. 必须由有权人回答的问题。

不得实现；不得把计划命令写成已执行 Evidence。
```

把实际运行结果追加到 `evidence.yaml`，调查结论写入 `02-impact-assessment.md`。既有失败与本需求失败分开。大需求拆成 Epic 和可独立接受的 Feature；`controlled` 或跨仓需求先设计 walking skeleton。

## 6. G1、G2 与 G2C

G1 前确认可判定 AC、边界、依赖和风险；G2 前确认设计、测试、Slice、baseline、size 和有界 Authorization Packet。

声明 Boundary 后物化其独立规范：

```bash
node <FRAMEWORK_ROOT>/scripts/materialize-boundary.mjs \
  <FEATURE_ROOT>/FEAT-001-task-history-export BND-001
```

然后分别评估：

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G1 <PACKAGE>
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G2 <PACKAGE>
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G2C \
  --instance BND-001 <PACKAGE>
```

一个 G2 Authorization Packet 可以覆盖多个明确列出的 Slice，但必须逐仓绑定 repository、base SHA、repo 内 path、允许/禁止 capability、`environment: local_engineering`、`account: null`、数据分类、预算、期限、Evidence、停止条件和重新授权触发器。G2C 逐 Boundary 解锁依赖它的 Slice，不扩大 G2 权限。

## 7. 按 Slice 实施

```text
实现 FEAT-001 / SLC-001，使用已验签的 G2 Authorization Packet。
仅修改 packet 列出的仓库与路径；先验证前置 SHA 和 Gate。
按测试 → 最小实现 → 局部验证 → 完整 diff 审查闭环执行。
范围、subject、依赖、环境或风险变化时立即停止并报告失效。
不得自行进行远端写、真实数据、付费调用、部署、migration 或不可逆动作。
```

完成后把真实命令、时间、版本、结果和 artifact 追加到 `evidence.yaml`，把面向人的覆盖解释写入 `08-verification-report.md`，再评估 Slice：

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh \
  --gate G3 --instance SLC-001 <PACKAGE>
```

G3/G4 `code_refs` 必须逐仓带 `sha + base_sha`。成功测试 Evidence 必须匹配同一代码主体并覆盖 AC；`controlled` 的 static analysis，以及 G4 的 review/security/data review，也必须逐仓精确匹配。

## 8. 工程完成与发布终点

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G4 <PACKAGE>
```

- `local_engineering`：终点为 G4，明确“工程完成、未发布”；
- `staging|production`：继续准备发布 DAG、制品、迁移、观察、停止和恢复，再走 G5/G6。

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G5 <PACKAGE>
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --gate G6 <PACKAGE>
node <FRAMEWORK_ROOT>/scripts/materialize-delivery-summary.mjs <PACKAGE>
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh --strict <PACKAGE>
```

Summary 只在 Target 终点有效通过后生成，不是 G4/G6 输入。`--strict` 证明治理闭环满足规则，不是“代码一定正确”的证明。

## 9. 提交前 changed-files 检查

Git base/head 语义、implementation commit 和 append-only 历史检查见 [integrations/git.md](integrations/git.md)。实际命令必须使用项目配置中的 repository ID、Feature root 和真实 base/head SHA；不要复制文档中的占位符。

若项目使用 GitHub，远端 required enforcement 还必须完成 [integrations/github-actions.md](integrations/github-actions.md) 的管理员步骤。本地检查和生成 workflow 文件都不能替代 branch protection。

## 10. 遇到旧包

```bash
<FRAMEWORK_ROOT>/scripts/check-feature-package.sh \
  --allow-legacy <LEGACY_V1_PACKAGE>
```

只有项目 legacy registry 中的 basename 与规范化 tree digest 都精确匹配时，才返回 `LEGACY_RECOGNIZED` inventory；`valid` 仍为 `false`，退出码仍为非零。继续开发旧需求时创建新的 v2 successor，详见 [MIGRATION_V1_TO_V2.md](MIGRATION_V1_TO_V2.md)。
