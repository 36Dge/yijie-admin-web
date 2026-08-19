# Codex Feature Delivery v2

Codex Feature Delivery v2 是一套可原子安装到任意 Git 项目的、可执行且可审计的新需求交付协议。它把稳定声明、执行证据和有权决策分开：Codex 可以调查、起草、实现、验证和审查，但不能用总结替代证据，也不能替人批准 Gate。

下载到桌面或其他可信位置的只读发行源称为 `<DISTRIBUTION_ROOT>`。初始化器从这里原子复制经过校验的发行内容到项目；安装后的项目内副本称为 `<FRAMEWORK_ROOT>`，默认是 `<PROJECT_ROOT>/docs/dev/codex-feature-delivery`。项目自己的配置和治理状态位于项目根，不写回发行源：

```text
<PROJECT_ROOT>/
├── .feature-delivery.yaml
├── .feature-delivery/
│   ├── approval-trust.yaml
│   ├── change-coverage-policy.yaml
│   ├── repository-registry.yaml
│   └── legacy-v1-allowlist.txt
├── <FEATURE_ROOT>/
│   └── <FEATURE-ID>-<slug>/
└── <FRAMEWORK_ROOT>/
    └── ...本发行包
```

项目路径、仓库拓扑、角色、CI、信任根和 Feature root 都由项目接入配置决定，不由本发行包假设。接入方法见 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)。

## 三层事实

1. `feature.yaml`：当前 Feature 声明，包括 Profile、Target、Boundary、Slice 与 artifact manifest。
2. `evidence.yaml`：append-only 执行事实，包括命令、版本、环境、时间、结果和制品。
3. `decisions.yaml`：append-only 有权决策，绑定精确 subject、Evidence、actor、roles、期限和签名。

解释性 Markdown 负责说明意图、设计和证据覆盖，但不是第二份状态账本。

## 六个核心不变量

1. **Profile 与 Target 正交**：`lite|standard|controlled` 决定控制深度，`local_engineering|staging|production` 决定生命周期终点。
2. **按实例交付**：G2C 对每个受影响 Boundary 独立判断，G3 对每个 Slice 独立判断。
3. **机器不替人批准**：evaluator 只输出 `ELIGIBLE|BLOCKED|NOT_APPLICABLE`；有效、验签通过的人类 Decision 才能形成 `passed`。
4. **内容寻址策略**：新包绑定 active Gate Policy；历史包继续绑定其不可变 policy snapshot。
5. **追加而非改写**：已登记 Evidence 和已签 Decision 只能追加失效、替代或纠正记录。
6. **默认拒绝**：身份、证据、授权、策略、路径或版本无法精确验证时 fail closed。

## Profile 与交付目标

| 维度 | 值 | 含义 |
|---|---|---|
| Profile | `lite` | 低风险、小范围、边界清晰；保留最小可验证材料 |
| Profile | `standard` | 常规产品和工程需求；完整设计、测试和集成链 |
| Profile | `controlled` | 高风险、受监管、敏感数据、复杂迁移、跨仓或难回滚；强化授权、审查和持久证据 |
| Target | `local_engineering` | 到 G4，证明工程完成但未发布 |
| Target | `staging` | 在预发布环境完成 G6 |
| Target | `production` | 在生产环境完成发布、观察与结果验证，到 G6 |

`controlled + local_engineering` 仍需受控工程证据，但不能据此声称已发布。

## Gate 路径

```text
G0 Intake Accepted
  → G1 Scope Ready
  → G2 Build Authorized
  → G2C Boundary Ready × 每个受影响 Boundary
  → G3 Slice Accepted × 每个 Slice
  → G4 Engineering Complete
  → G5 Release Authorized
  → G6 Outcome Verified
```

Gate 派生状态为 `pending|blocked|ready|in_review|passed|failed|stale|not_applicable`。Decision 不能自报 `not_applicable`；subject、关键 Evidence、策略或前置 Gate 变化时，旧决定必须失效或变为 `stale`。

## 发行包结构

```text
<DISTRIBUTION_ROOT>/
├── README.md
├── QUICKSTART.md
├── HANDBOOK.md
├── PROJECT_ADOPTION.md
├── DOCUMENT_CATALOG.md
├── CODEX_PLAYBOOK.md
├── QUALITY_GATES.md
├── MIGRATION_V1_TO_V2.md
├── package.json
├── package-lock.json
├── RELEASE-MANIFEST.json
├── gate-policy.yaml
├── config/
│   └── *.example.yaml
├── integrations/
│   ├── git.md
│   ├── github-actions.md
│   └── github/
├── policies/
├── schemas/
├── scripts/
├── templates/
├── checklists/
├── examples/
└── tests/
```

`<DISTRIBUTION_ROOT>/config/*.example.yaml` 只是接入输入样例，不能充当项目的有效治理配置。初始化器根据项目参数原子复制发行包到 `<FRAMEWORK_ROOT>`，并生成 `.feature-delivery.yaml` 和 `.feature-delivery/`；已存在的目标或冲突不得被静默覆盖。生成后必须由项目负责人复核并提交。

`package.json.version` 是发行版本。`RELEASE-MANIFEST.json` 逐文件绑定发行 payload 的规范路径、Git mode、字节长度和 SHA-256，并给出整体 `distribution_digest`、active policy digest 及内容寻址 snapshot。为避免自引用固定点，manifest 明确只排除自身和运行时安装目录 `node_modules/**`；其余发行文件必须全部出现。安装、升级或发布前运行 `npm run release:check`，任何缺失、增删或字节漂移都必须 fail closed。

## 安装与初始化

需要 Node.js 24–26。首次初始化从发行源运行；初始化成功后，再为项目内 Framework 安装依赖。所有安装均禁止 lifecycle scripts：

```bash
(cd "<DISTRIBUTION_ROOT>" && npm ci --ignore-scripts)
(cd "<DISTRIBUTION_ROOT>" && npm run release:check)

node <DISTRIBUTION_ROOT>/scripts/init-project.mjs \
  --project-root <PROJECT_ROOT> \
  --project-id <PROJECT_ID> \
  --repository-id <REPOSITORY_ID> \
  --actor-id <ACTOR_ID> \
  --ci none

(cd "<FRAMEWORK_ROOT>" && npm ci --ignore-scripts)
(cd "<FRAMEWORK_ROOT>" && npm run release:check)
```

`--primary-branch <BRANCH>` 是可选初始化参数。省略时，初始化器探测目标 worktree 当前 symbolic branch；若目标处于 detached HEAD，无法安全推断主分支，必须显式提供该参数。

`--ci github` 会在同一原子初始化中生成候选 GitHub adapter，但不会创建 GitHub App、Environment、repository variables、required status 或 branch protection。管理员必须按 [GitHub Actions 接入指南](integrations/github-actions.md) 完成外部配置；未完成时 CI enforcement 保持未启用或 fail closed。

## 核心规范与 Adapter 的边界

- [HANDBOOK.md](HANDBOOK.md)、[QUALITY_GATES.md](QUALITY_GATES.md) 定义与平台无关的生命周期、Evidence 和 Decision 语义。
- [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md) 定义每个项目必须作出的接入选择。
- [integrations/git.md](integrations/git.md) 定义当前 Git 版本绑定和 changed-files 算法。
- [integrations/github-actions.md](integrations/github-actions.md) 是可选 GitHub enforcement adapter，不是核心协议。

迁移到其他 CI/SCM 时，可以替换 adapter，但不得弱化精确 subject、append-only 历史、外部信任根、受保护验证器和 fail-closed 语义。

## 从这里开始

- 第一次接入项目：[PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)
- 创建第一个包：[QUICKSTART.md](QUICKSTART.md)
- 完整生命周期：[HANDBOOK.md](HANDBOOK.md)
- Gate 断言：[QUALITY_GATES.md](QUALITY_GATES.md)
- 文档职责：[DOCUMENT_CATALOG.md](DOCUMENT_CATALOG.md)
- Codex 实施规程：[CODEX_PLAYBOOK.md](CODEX_PLAYBOOK.md)
- v1 迁移：[MIGRATION_V1_TO_V2.md](MIGRATION_V1_TO_V2.md)

## 责任边界

同一人可以承担多个真实角色，但不得伪造独立人审。Codex Review、静态分析和测试都是 Evidence，不是批准。审批私钥必须位于待审代码和 Codex 不可访问的受保护面。真实数据、外部写入、付费调用、部署、迁移和不可逆动作必须取得针对精确目标的新授权。
