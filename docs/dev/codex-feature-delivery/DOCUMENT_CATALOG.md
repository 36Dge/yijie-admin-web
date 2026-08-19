# 文档与机器产物目录

v2 只有三个 Feature 事实层：当前声明、追加账本、解释性文档。项目接入配置与发行包策略是这些事实的外部输入。相同事实只设一个权威位置，其他文件用 ID 引用，避免状态漂移。

## 发行包与项目实例

| 位置 | 性质 | 职责 |
|---|---|---|
| `<DISTRIBUTION_ROOT>/` | 只读发行源 | 由下载位置提供初始化器、锁定依赖、模板、策略和 adapter；不承载项目实例状态 |
| `<FRAMEWORK_ROOT>/` | 项目内 Framework | 由初始化器从发行源原子复制，默认安装到 `docs/dev/codex-feature-delivery` |
| `<FRAMEWORK_ROOT>/gate-policy.yaml` | active 发行策略 | 新 Feature 使用的 Gate/Profile/Target 规则 |
| `<FRAMEWORK_ROOT>/policies/<sha256>.yaml` | 不可变策略注册表 | 按原始 bytes digest 保存 active 与历史快照 |
| `<FRAMEWORK_ROOT>/schemas/` | 发行契约 | 严格约束项目配置、Feature Package 与 Gate Policy |
| `<PROJECT_ROOT>/.feature-delivery.yaml` | 项目当前配置 | Framework/Feature root、project/repository identity、adapter 与治理文件引用 |
| `<PROJECT_ROOT>/.feature-delivery/` | 项目实例治理目录 | trust root、coverage policy、repository registry 与 legacy registry |

项目初始化与字段选择见 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)。

## 机器权威源

| 文件 | 性质 | 职责 | 禁止事项 |
|---|---|---|---|
| `<FRAMEWORK_ROOT>/gate-policy.yaml` | active 体系策略 | 新 Feature 使用的 Gate、Profile、Target、适用性、前置和失效规则 | 把 active 当成历史 Package 的浮动依赖；改 bytes 却不归档 |
| `<FRAMEWORK_ROOT>/policies/<sha256>.yaml` | 不可变策略注册表 | 按原始 bytes SHA-256 保存 active 与历史 Gate Policy 快照 | 覆盖、删除、重命名快照；文件名 digest 与内容不一致 |
| `.feature-delivery/approval-trust.yaml` | 外部审批信任根 | 受信 Ed25519 公钥、actor/role/Gate/Profile/Target 范围与有效期 | 从待审 head 自增 key 后自批；把私钥提交入仓 |
| `.feature-delivery/change-coverage-policy.yaml` | diff 覆盖策略 | repository、Feature root、最低 Gate、protected governance path 与精确 exemption | 用 PR 自由文本或普通环境变量临时豁免；用 head policy 验证自身 |
| `.feature-delivery/repository-registry.yaml` | 仓库身份注册表 | 稳定 repository ID、规范 URL 与 checkout identity | 依赖目录名猜身份；把 repo 内 scope 混入 checkout root |
| `.feature-delivery/legacy-v1-allowlist.txt` | v1 只读 pin registry | 逐个固定已登记 basename 与规范化 tree digest | 新建 v1；修改历史包后重算 pin 掩盖漂移 |
| `<FRAMEWORK_ROOT>/schemas/feature-package.schema.json` | 结构契约 | `feature.yaml` 字段、枚举和引用格式 | 用 Markdown 代替机器必填字段 |
| `<FRAMEWORK_ROOT>/schemas/gate-policy.schema.json` | 策略契约 | Gate/Override/Profile/Target 的闭合字段、类型与安全关键必填项 | 删除或拼错控制字段后依赖运行时默认值 |
| `feature.yaml` | 当前声明 | Feature 身份、Profile/Target、Owner、风险、仓库、boundary、slice 和 artifact manifest | 保存 Gate 状态或历史；复制 evidence/decision 内容 |
| `evidence.yaml` | append-only 事实账本 | 命令、环境、时间、SHA、退出码、制品、日志和实际结果 | 预写未来结果；原地改写旧记录；用计划冒充执行 |
| `decisions.yaml` | append-only 决策账本 | Gate 实例、decision、actor/roles、精确 subject、evidence、时间、期限、外部签名和失效关系 | Codex 自批；无 subject 的“同意”；仅写 `human` 不验签；伪造独立 Reviewer |

机器 evaluator 对三者和策略做一致性判断：适用 Gate 只输出 `ELIGIBLE` / `BLOCKED`，policy 裁剪实例输出 `NOT_APPLICABLE`。`passed` 来自有效决策，不来自脚本自动写入。

`<FRAMEWORK_ROOT>/scripts/policy-registry.mjs` 是 evaluator、签名器、Summary materializer 与生成器共享的策略解析入口；对应测试固定 active/archive 字节一致、缺失/篡改拒绝和 active 切换后历史 Package/Decision 仍可验证的回归。

### 避免 SHA 自引用

决策绑定被判断对象，而不是“包含该决策记录的最终提交 SHA”。例如 G3 subject 绑定实现 commit、测试输入、契约 digest 和授权包版本；决策账本所在提交可另行追踪，但不要求其 SHA 出现在自身内容中。若 subject 变化，追加失效/替代记录，不覆盖旧记录。

## Feature Package 文档

| 产物 | 生成时点 | 唯一职责 | 主要事实来源 | 默认适用性 |
|---|---|---|---|---|
| `00-feature-brief.md` | Intake | 问题、价值、范围、非目标、成功指标 | 需求 Owner | 全部 |
| `01-requirements.md` | Scope | 编号化规则、AC/NFR、状态与错误语义 | 业务决定 | 全部 |
| `02-impact-assessment.md` | 调查 | 仓库、baseline、size、依赖、边界、数据流、已有改动 | 只读代码/CI/Git 证据 | 全部 |
| `03-decisions-and-risks.md` | 设计前后 | 选项、风险、Open Question 及决策 ID 索引 | `decisions.yaml` 与 Owner 输入 | standard/controlled；风险触发升级后按新 Profile 路由 |
| `04-contract-change-plan.md` | Scope/G2 | Boundary ID 到独立 artifact 的导航索引；不承载共享语义 | `feature.yaml.boundaries[].artifact_id` | 有 Boundary 时 required；无实例时不 materialize |
| `boundaries/<BND-ID>.md` | 该 G2C 前 | 一个 boundary 的权威源、兼容、consumer、版本与演进 | Schema/生成器/consumer 基线 | 每个已声明 boundary 独立一份 |
| `05-technical-design.md` | G2 前 | 架构、状态、失败、安全、数据、观测与恢复 | 已确认需求和真实代码 | standard/controlled；复杂度触发升级后按新 Profile 路由 |
| `06-test-plan.md` | G2 前 | AC/风险到验证层级、fixture、环境和判定阈值的映射 | 需求、风险与设计 | 全部；lite 使用精简内容 |
| `07-implementation-plan.md` | G2 前 | Epic/slice、walking skeleton、依赖和 authorization packet 索引 | 设计与实际依赖 | 全部 |
| `08-verification-report.md` | 实施期间 | 对 evidence 的可读解释、覆盖矩阵、缺口和 Review findings | `evidence.yaml` | 全部 |
| `09-release-and-rollback.md` | G5 前 | 目标环境、发布 DAG、安全不变量、灰度、停止和恢复 | 真实制品与控制面 | staging/production；local 按需 |
| `10-delivery-summary.md` | Target 终点有效通过后 | 机器绑定完整 terminal Decision record digest 的闭环导航；派生正文不是 Gate 证据 | 当前 manifest、账本和 terminal Gate | 初始 conditional；从 manifest/ledger canonical 重建并逐字校验；不是 G4/G6 输入 |

## 物理裁剪规则

1. 风险信号先决定最低允许 Profile；再由 `profile + target + 是否存在 Boundary` 决定最低产物集合。Boundary 类型决定独立规范内容，不绕过 Profile 路由。
2. 实际文件由 `feature.yaml.artifacts` 索引；存在即必须满足相应模板，省略必须有策略允许的理由。
3. 条件在实施中出现时，先更新 manifest 并生成新增文档，再继续；不能把缺失文档当隐含 `not_applicable`。
4. Markdown 中不复制 Gate 当前状态、完整 evidence 或批准正文，只引用稳定 ID，避免多处漂移。
5. 计划命令只写在 06/07/09；执行结果只进入 `evidence.yaml`，08/10 负责解释和汇总。

`materialize-boundary.mjs <package> <BND-ID>` 只为已声明的 Boundary 建立独立规范，不复制一份全局 Contract 文档。`materialize-delivery-summary.mjs` 只在 Target 终点有效通过后运行，生成绑定 terminal Decision record digest 的严格 frontmatter；evaluator 从当前 manifest/ledger canonical 重建正文逐字校验，不把 `summary_body_digest` 当作唯一事实。Summary 生成后不手改；主体变化时先追加新 terminal decision，在受审查的变更中移除可由 Git 恢复的旧派生 Summary，再运行 materializer；脚本本身不覆盖已有文件。

## Gate 与 digest 输入

| Gate | Digest | 主要文档输入 |
|---|---|---|
| G0 | `intake_digest` | 00 |
| G1 | `scope_digest` | 00–02 |
| G2 | `build_digest` | Scope + 03/05/06/07 + 当前 baseline/依赖 |
| G2C | `boundary_digest[ID]` | 该 `boundaries/<BND-ID>.md` |
| G3 | `slice_digest[ID]` + code refs | 该 Slice 声明与对应 ledger Evidence；08 不作单 Slice Gate 输入 |
| G4 | `engineering_digest` + code refs | 全部工程实例与 08 |
| G5/G6 | `release_digest` + code/engineering-decision/artifact/environment/account refs | 09、当前 G4 与目标环境证据 |

Markdown 完成度按上表的阶段检查；未到阶段的文档占位不阻塞早期 Gate。`--strict` 和 `lifecycle: completed` 要求全部适用文档、Gate 与终点摘要完整。

## 记录最小字段

一条 evidence 至少包含：稳定 ID、kind、subject、repository/cwd、完整命令或工具动作、开始/结束/记录时间、环境、代码/制品精确版本、exit code、`passed|failed|not_run`、日志或 artifact 引用。时间不得倒置或落在未来；被决策引用的成功 evidence 需有 digest 与未过期保留期的持久 artifact。`not_run` 必须有原因和补验证条件，且永不算绿色。

一条 decision 至少包含：稳定 ID、Gate 与存在的 instance、`state`（Decision 枚举不含 `not_applicable`）、可追溯人类 actor、其在 manifest 已分配的真实 roles、decided_at、精确 `policy_digest`、分段 subject digest、evidence refs、有效期或失效条件、`attestation`，以及可选 `supersedes`。`passed` 的 attestation 必须由包外 trust root 中 scope 匹配的 Ed25519 key 验证；仅自报 actor/role 不成立。一个人可声明多个 roles，但不得声称不存在的独立人审；Codex Review 只作为 evidence 引用。失效或替代通过追加 `stale`/新记录表达，不发明 schema 外的 decision 值。
