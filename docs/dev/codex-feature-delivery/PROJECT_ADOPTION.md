# 项目接入指南

本文把通用发行包绑定到一个真实项目。完成接入之前，项目不得宣称 Feature Delivery v2 已被 CI 强制执行。

## 1. 接入输入

先确定以下占位符：

| 占位符 | 含义 | 示例 |
|---|---|---|
| `<DISTRIBUTION_ROOT>` | 下载到桌面或其他可信位置的只读发行源 | `/downloads/codex-feature-delivery-v2` |
| `<PROJECT_ROOT>` | 当前项目 Git 根目录 | `/work/example-service` |
| `<FRAMEWORK_ROOT>` | 初始化器原子复制出的项目内 Framework | 默认 `<PROJECT_ROOT>/docs/dev/codex-feature-delivery` |
| `<FEATURE_ROOT>` | Feature Package 根目录 | `<PROJECT_ROOT>/docs/features` |
| `<PROJECT_ID>` | 稳定项目标识 | `example-service` |
| `<REPOSITORY_ID>` | 当前仓库的稳定标识 | `service` |
| `<ACTOR_ID>` | 首位可追溯负责人标识 | `approver.example` |

Framework root 与 Feature root 使用表中的默认值；其他表格内容只是示例。正式值必须写入 `.feature-delivery.yaml`，脚本和文档均从项目配置解析，不通过目录名猜测。

`.feature-delivery.yaml` 和 `.feature-delivery/` 是协议保留的项目元数据路径，不是接入时可自定义的布局选项。Framework root、Feature root 和 repository 路径可以通过配置选择，但不得重命名或迁移这两个治理入口。

## 2. 安装与初始化

使用 Node.js 24–26。先在发行源安装锁定依赖，并禁止 lifecycle scripts：

```bash
(cd "<DISTRIBUTION_ROOT>" && npm ci --ignore-scripts)
(cd "<DISTRIBUTION_ROOT>" && npm run release:check)
```

然后从发行源调用初始化器。此时 `<FRAMEWORK_ROOT>` 尚不存在；初始化器会校验输入，并把发行内容、项目配置、治理文件和所选 CI adapter 作为一个原子操作写入项目。已有目标、部分复制或冲突必须 fail closed，不得静默合并：

```bash
node <DISTRIBUTION_ROOT>/scripts/init-project.mjs \
  --project-root <PROJECT_ROOT> \
  --project-id <PROJECT_ID> \
  --repository-id <REPOSITORY_ID> \
  --actor-id <ACTOR_ID> \
  --ci none
```

`--primary-branch <BRANCH>` 可选。省略时，初始化器读取目标 worktree 当前 symbolic branch 作为 primary branch；如果目标是 detached HEAD，则不存在可安全推断的 branch，初始化必须 fail closed，调用者必须显式传入 `--primary-branch`。

初始化成功后，再安装项目内 Framework 的锁定依赖：

```bash
(cd "<FRAMEWORK_ROOT>" && npm ci --ignore-scripts)
(cd "<FRAMEWORK_ROOT>" && npm run release:check)
```

GitHub 项目可以选择 `--ci github`，让初始化器在同一原子操作中生成候选 adapter 文件，但这仍然只是候选配置。外部管理员设置见 [integrations/github-actions.md](integrations/github-actions.md)。

初始化器应创建或补齐：

```text
<PROJECT_ROOT>/
├── .feature-delivery.yaml
└── .feature-delivery/
    ├── approval-trust.yaml
    ├── change-coverage-policy.yaml
    ├── repository-registry.yaml
    └── legacy-v1-allowlist.txt
```

初始化后先做 diff review。工具不得静默覆盖已有项目治理文件；冲突时停止并要求人工选择。

## 3. 项目配置必须回答的问题

### 路径与仓库

- Framework root 和 Feature root 是什么；
- 单仓、monorepo 或多仓如何登记；
- 每个 repository 的稳定 ID、规范 URL、checkout root 和允许路径；
- 哪些路径属于治理 TCB，哪些普通变更必须由 Feature Package 覆盖；
- 多仓 checkout 如何定位；项目根内路径登记为 `managed`，项目根外只允许显式登记的单层 `external` checkout。

`.feature-delivery/repository-registry.yaml` 是项目仓库身份注册表。`managed` 只表示项目根内已登记路径；`external` 只表示显式登记的单层项目外 checkout，例如经 registry 固定的 `../shared-contracts`。相邻目录不是天然禁止，但未登记路径、隐式拓扑和多层项目外跳转一律拒绝。repository identity 与 repo 内修改 scope 是两层事实；绝对路径、`..`、空段、反斜杠或 glob 不得进入 Slice/Authorization path。

### 人员、角色与审批

- 哪些稳定 actor ID 对应哪些真实人员；
- 谁可以承担 `accountable_owner`、`requirement_owner`、`technical_owner`、`reviewer`、`release_owner` 等角色；
- 哪些 Gate/Profile/Target 需要独立人审；
- key scope、有效期、轮换和吊销流程；
- 谁能管理 trust root，谁能读取审批私钥。

`approval-trust.yaml` 只保存公钥和 scope。私钥必须位于项目工作区、待审变更和 Codex 不可访问的受保护审批面。单人项目可以由同一人承担多个已登记角色，但不能伪造第二个人或把 Agent Review 写成人类批准。

### 数据、环境与外部副作用

- 项目的数据分类和受限数据定义；
- `local_engineering|staging|production` 对真实环境的映射；
- 真实账户、云账号和 deployment target 的稳定引用；
- 外部写、消息、付费服务、迁移和不可逆操作的授权人；
- Evidence artifact 的存储、不可变 URI、digest 核验与保留期。

Target 只是生命周期终点，不自动授予环境访问权限。G5 也必须绑定精确 environment、account、artifact 和动作。

### 工具链和验证

- baseline、lint、test、build、generate、contract 和 E2E 命令从哪里读取；
- 哪些输出必须持久保存；
- controlled Profile 的 static/security/data review 由什么系统产生；
- 谁在受保护面验证 artifact bytes 与 digest 一致；
- 依赖、生成器、模型、prompt、dataset 和迁移工具如何版本锁定。

不要把本手册中的示例命令当作项目事实。真实命令必须来自仓库脚本、构建定义、CI 或受控 Runbook。

## 4. 选择 enforcement adapter

核心协议不依赖特定托管平台，但当前实现使用 Git commit、tree 和 diff 作为版本身份。Git 约束见 [integrations/git.md](integrations/git.md)。

| 模式 | 适用场景 | 项目责任 |
|---|---|---|
| `ci: none` | 本地试用或尚未接入受保护 CI | 不得宣称 required check 已启用；人工执行 evaluator |
| `ci: github` | GitHub Actions 与 branch protection | 配置 App、Environment、variables、required status 和 up-to-date 规则 |
| 自定义 adapter | 其他 CI/托管平台 | 实现同等 base-trusted、append-only、external-digest 和 fail-closed 语义 |

自定义 adapter 必须证明：验证器来自受保护 base；候选代码不能修改或执行验证器；结果绑定精确 candidate；治理 TCB 变更需要包外第二通道；验证失败或状态发布失败不会放行。

## 5. Legacy 策略

全新项目保持 `.feature-delivery/legacy-v1-allowlist.txt` 为空。存在旧包时，逐个登记 basename 与规范化 tree digest；不要预设历史包数量，也不要为通过检查而新建 v1 包。详细规则见 [MIGRATION_V1_TO_V2.md](MIGRATION_V1_TO_V2.md)。

## 6. 接入验收

接入完成至少满足：

- [ ] `.feature-delivery.yaml` 中没有示例占位符，路径可从项目根解析
- [ ] 初始化使用 Node.js 24–26，发行源与 Framework 均在目标目录中执行 `(cd "<PATH>" && npm ci --ignore-scripts)`
- [ ] 发行源与 Framework 的 `npm run release:check` 均通过，版本、完整 payload manifest、整体 SHA-256、active policy 与 snapshot 一致
- [ ] repository registry 覆盖所有受管理仓库，URL/root/ID 无歧义
- [ ] trust root 与审批私钥位于不同信任域，默认无全域 key
- [ ] Profile、Target、数据分类和角色映射已由项目负责人确认
- [ ] Feature root、治理 TCB 路径和 changed-files policy 精确
- [ ] Evidence artifact 存储、digest 核验和保留期可执行
- [ ] 初始化器、Schema、policy registry、evaluator 和 materializer 测试通过
- [ ] 若启用 CI，required status 的来源、保护规则和失败行为已实际验证
- [ ] 若未启用 CI，文档明确标注“流程可用，但未被远端强制”
- [ ] 已创建一个虚构或低风险试点包，完成 G0/G1 演练且未把 ELIGIBLE 当作 passed

## 7. 升级发行包

升级前记录当前发行版本、`distribution_digest` 和 policy digest；先在隔离分支运行 `npm run release:check`、Schema、policy registry、evaluator、签名、materializer 与 adapter 回归。Gate Policy 必须先新增按原始 bytes SHA-256 命名的不可变快照，再切换 active policy。历史快照和已有 Decision 不得批量重写。

项目配置迁移和框架升级是治理 TCB 变更，不应与普通 Feature 实现混在一个变更集中。
