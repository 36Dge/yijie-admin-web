# Codex Feature Delivery v2 完整手册

本文定义核心生命周期和不可变语义，不假设项目目录、仓库拓扑或 CI 托管平台。项目实例化见 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)；当前 Git 和 GitHub adapter 分别见 [integrations/git.md](integrations/git.md) 与 [integrations/github-actions.md](integrations/github-actions.md)。

## 1. 这套体系解决什么

V2 把一次需求交付拆成三个互不替代的层次：

1. **工程工作**：调查、设计、实现、测试、审查、发布与观察；
2. **执行事实**：谁在什么版本、环境和目录执行了什么，实际结果是什么；
3. **有权决策**：谁基于哪些精确事实，批准或拒绝哪个 Gate 实例。

Codex 擅长第一层并可帮助整理第二层，但没有证据就不能声称结果，没有有权决策就不能声称 Gate 通过。机器 evaluator 对适用 Gate 只判断 `ELIGIBLE` 或 `BLOCKED`，对 policy 裁剪实例输出 `NOT_APPLICABLE`；它不产生 APPROVED。

## 2. 不可破坏的原则

### 2.1 契约与边界优先

跨进程、跨仓、跨团队或跨信任域的行为先建立 boundary。每个受影响 boundary 有独立 G2C，分别绑定权威源、producer、consumer、语义基线、兼容证据和演进顺序。不得以影子 DTO、手工复制 Schema 或“应该兼容”替代。

### 2.2 计划事实与执行事实分离

- 计划执行的命令写在测试、实施或发布计划中；
- 实际执行的命令只追加到 `evidence.yaml`；
- `08-verification-report.md` 解释证据覆盖和缺口，不成为第二证据账本；
- `not_run` 是未执行，不得计为成功；
- 未来 tag、commit、digest、环境状态和批准不得预填为事实。

### 2.3 授权窄于计划

G2 表示构建计划获准，不表示获得任意文件、账户和环境的写权限。一个有界 G2 Authorization Packet 可以覆盖多个明确列出的 Slice；每个 Slice 的范围仍须被 packet 精确覆盖，开工前都要确认 packet 未过期、未失效，不额外制造逐 Slice 人工批准。外部写、真实数据、付费服务、部署、migration 和不可逆操作总是针对精确目标重新授权。

### 2.4 历史追加，不覆盖

`evidence.yaml` 与已签名/已登记的 `decisions.yaml` 记录是 append-only。`attestation: null` 的待审记录只是尚未成立的草案；签名并登记后，错误通过后续纠正/失效记录处理，不原地改写。`feature.yaml` 是当前声明，可随已确认事实更新；evaluator 负责检查其当前状态是否能由账本支持。

### 2.5 一人多角色不等于独立评审

单人项目允许同一位负责人承担 Business、Technical、Verifier、Release 等角色，并在一次 decision 中列出其在 `feature.yaml.feature.owners.role_assignments` 中真实已分配的 `roles`。`passed` 的 actor 必须是可追溯的人，且完整 Decision 必须由包外 `.feature-delivery/approval-trust.yaml` 中 scope 匹配的 Ed25519 key 验签；YAML 自报 `human` 不构成身份。私钥只能存在于 Codex/待审代码不可访问的受保护审批面，CI 使用受保护 base 或独立 mount 的 trust root。不得为满足形式伪造第二个人。Codex Review、另一个 Agent 的审查、静态分析和 CI 都是 evidence；如果组织要求独立人审，必须由真实独立人完成，否则 Gate 保持阻塞或明确降级决策。

## 3. 权威源与优先级

出现冲突时按下列顺序处理，而不是静默挑一个方便的版本：

1. 组织/仓库适用的安全、合规和授权规则；
2. `<FRAMEWORK_ROOT>/gate-policy.yaml`、其 `policies/<sha256>.yaml` 内容寻址快照与 JSON Schema；
3. Accepted 决策、契约权威源和真实代码/环境事实；
4. `feature.yaml` 当前声明；
5. Feature Package Markdown 的解释；
6. 聊天记录和个人推断。

发现矛盾后停止受影响工作，记录冲突、影响和需要的有权选择。决定后更新当前声明；旧 evidence/decision 保留并追加失效关系。

### 3.1 Gate Policy 内容寻址与升级

`<FRAMEWORK_ROOT>/gate-policy.yaml` 只是供新 Feature 使用的 active 指针，不是历史 Package 的浮动依赖。每个策略版本必须按原始文件 bytes 计算 SHA-256，并在 `<FRAMEWORK_ROOT>/policies/<64-lowercase-hex>.yaml` 保存完全相同的不可变快照。运行时先严格校验 active policy，再要求 active bytes 与同 digest 快照逐字节一致；解析 Package 时，digest 命中 active 就使用 active，否则只允许读取同名历史快照。快照的实际 digest、Gate Policy Schema、`policy.id` 和 `policy.version` 任一不匹配都 fail closed。

升级顺序固定为：准备新策略 bytes → 计算 digest → 新增同名快照 → 在同一个受治理、外部 digest 批准的 TCB 变更中把 active 切到相同 bytes → 通过 registry/schema/回归 → 合并。历史快照只增不改、禁止删除；已有 Package/Decision 不改 digest、不重新签名，继续由历史 verifier 语义复核。新 Package 的 id/version/digest 由 `new-feature.sh` 从已归档的 active policy 读取，不从模板硬编码。若 active 改了 bytes 却没有匹配快照，生成器、evaluator、签名器和 Summary materializer 全部停止。当前 `gate-policy.schema.json` 必须保持能严格验证所有仍受支持的历史快照；需要破坏性 Schema 演进时，应先引入显式 schema registry/版本路由，不能直接让旧快照失效。

## 4. 核心模型

### 4.1 Profile：风险控制深度

- `lite`：低风险、小范围、边界清晰；保留最小可验证材料；
- `standard`：常规产品和工程需求；完整设计、测试和集成链；
- `controlled`：高风险、受监管、敏感数据、breaking、复杂 migration、跨仓/多消费者、外部副作用或难回滚。

Profile 由 G0/G1 的事实选择，并受策略中的风险信号约束。实施中出现更高风险时先提升 Profile、补产物并使受影响决定失效；不得为了减少文档而降级。降级必须有可审计理由和有权决策。

`controlled` 会改变机器要求，而不只是文档语气：授权有效期更短，必须提供更强的 static analysis、security review，涉及受限数据时还需 data review；证据制品必须持久、有 digest 且保留期覆盖决策有效窗口。

### 4.2 Target：生命周期终点

- `local_engineering`：到 G4，证明工程完成但未发布；
- `staging`：在 staging 完成发布与结果验证，到 G6；
- `production`：在 production 完成发布、观察和业务结果验证，到 G6。

Target 与 Profile 正交。改变 Target 会改变 artifact 和 Gate 适用性，并使依赖目标环境的旧决定失效。

### 4.3 Artifact manifest：物理裁剪

模板目录是能力全集，不是每个包的固定十二件套。初始生成器按 Profile 与 Target 写入 `feature.yaml.artifacts` 并物理创建所需 Markdown；后续风险/Boundary 变化先更新 manifest，再由 evaluator 与 materializer fail-closed 路由。规则是：

- 核心三件套 `feature.yaml`、`evidence.yaml`、`decisions.yaml` 永远存在；
- 被策略要求的文档必须存在且非占位；
- 省略文档必须由 artifact manifest 给出策略依据与理由；
- 新风险触发新文档时，先更新 manifest/生成文档，再继续实施；
- 不创建空文件来假装适用，也不静默删除已承载历史事实的文件。

### 4.4 Boundary 与 Slice

Boundary 是跨职责/契约/信任边界的接口，例如 API、event、database、authorization、external-service、AI-tool。每个有影响的 boundary 建 G2C 实例。

Slice 是可独立验证、可回滚、可审查的实现单元。每个 slice 建 G3 实例，并声明依赖 boundary 与其他 slice。一个 Feature 可以有多个仓库，但 slice 的修改范围必须精确到仓库和路径。

### 4.5 Gate 状态机

```text
pending → ready → in_review → passed
    │         │          │       │
    └──────→ blocked/failed      └→ stale

policy 对 Target/实例派生：not_applicable（不追加 N/A decision）
```

唯一状态集合为 `pending|blocked|ready|in_review|passed|failed|stale|not_applicable`。状态不是由作者随意涂色：当前 `passed` 必须能追溯到有效 decision；变化导致 subject 不再相同时，旧决定转为 `stale`。

### 4.6 分段 digest 与实例隔离

evaluator 不用一个“全包 digest”迫使无关实例一起失效，而是按决策对象计算：

| Gate | 绑定 digest | 覆盖范围 |
|---|---|---|
| G0 | `intake_digest` | 当前声明与 `00-feature-brief.md` |
| G1 | `scope_digest` | Intake、requirements、impact 和边界/规模声明 |
| G2 | `build_digest` | Scope、当前 baseline/依赖状态、决策/设计/测试/切片计划 |
| G2C | `boundary_digest[ID]` | 一个 Boundary 声明及其独立 `boundary_spec` |
| G3 | `slice_digest[ID]` + `code_refs` | digest 覆盖一个 Slice 声明、相关 Boundary/Slice 与 repo baseline；Decision 另行绑定当前代码 |
| G4 | `engineering_digest` + `code_refs` + Evidence refs | digest 覆盖 build、全部实例和 08；Decision 另行绑定最终代码与逐仓验证 |
| G5/G6 | `release_digest` + code/artifact/environment/account refs | digest 覆盖 engineering 与 09；Decision 另行绑定当前 G4、代码、制品与目标环境，G6 精确继承 G5 |

某个 Boundary 变化会使它的 G2C、依赖它的 Slice 及后续集成失效，不应让无关 Boundary/Slice 一起过期。当前 baseline、依赖解决状态或 G2 计划改变时，`build_digest` 必须改变，不能用稳定声明 digest 绕过重新授权。

### 4.7 Gate-aware 完成度

Schema、引用、路径和 ledger 完整性始终检查；Markdown 占位符则只在它已成为当前 Gate 输入时阻塞。G0 不因未填的发布计划失败，G2C 只检查该 Boundary 的独立规范。`--strict` 或 `lifecycle: completed` 必须验证全部适用 Gate、已到期文档以及终点后生成的 Summary，不允许用 `completed` 跳过闭环。

## 5. 从 Intake 到工程完成

### 阶段 A：G0 Intake Accepted

#### 目标

先决定“是否值得且允许调查”，不急于决定实现方案。

#### 必须完成

- 创建 v2 包，显式选择 Profile 与 Target；
- 写清问题、用户价值、目标、非目标、Owner、成功指标；
- 声明初始数据分类、真实账户、外部副作用、费用和不可逆风险；
- 列出已知仓库线索、未知项、只读调查范围和禁止动作；
- 检查 artifact manifest 与策略路由一致。

#### 允许做什么

可以读取公开/授权的仓库与文档，检查无副作用状态。除非另有精确授权，不得修改业务代码、访问真实敏感数据或触发外部副作用。

#### Gate

evaluator 确认资料是否 `ELIGIBLE`；有权 Owner 对当前 Intake subject 追加决策。决定绑定 Profile、Target 和 brief 版本，任何一个变化都需重新判断。

### 阶段 B：G1 Scope Ready

#### 只读事实调查

逐仓执行：

1. 读取当前路径适用的 `AGENTS.md`、README、SECURITY、CONTRIBUTING、ADR 和 CI；
2. 记录 remote、branch、完整 HEAD、工具链、工作区状态及用户已有改动；
3. 定位入口、调用链、数据存储、测试、生成器、配置和发布控制面；
4. 画出 producer、consumer、数据、权限、外部系统和 AI tool 边界；
5. 区分 `Fact / Assumption / Unknown`，不按目录名猜所有权。

#### Baseline

G2 前必须对每个受影响仓库运行最小且可重复的 baseline。记录 cwd、命令、完整 SHA、工具版本、时间、退出码和日志引用。baseline 失败时：

- 确认是否在当前 HEAD 可重复；
- 与需求引入的失败分开；
- 给出 Owner、影响和后续处置；
- 未被有权人接受前，不把“原本就失败”当作绿色。

#### Size 与依赖

评估范围、仓库数、boundary 数、slice 数、未知量、关键路径、外部团队/平台、迁移和回滚难度。若 Feature 无法在一个可理解的评审单元内闭环，拆成 Epic 和多个 v2 Feature Package：每个子 Feature 有独立 AC、Gate 和证据，Epic 只管理依赖和共同结果，不共享一个总 G3/G4。

#### G1 结论

批准 subject 必须包含 requirements、impact、size/dependency 与 boundary 清单的精确版本。新增 consumer、仓库或敏感数据会使 G1 及依赖 Gate 失效。

### 阶段 C：G2 Build Authorized

#### 先关闭决策

对架构、安全、数据、第三方、AI、兼容、migration、成本和发布选项记录：事实、可选项、取舍、选择权人、截止时间和 decision ID。未决项如果会改变实现，则保持 blocked；不能让 Codex暗自选择后继续。

#### 技术设计

设计至少覆盖适用项：

- 模块职责、依赖方向和状态机；
- 正常、失败、并发、幂等、超时、取消、重试和部分成功；
- 认证、资源授权、租户隔离、审计、secret 和日志脱敏；
- 数据生命周期、新旧 reader/writer 共存、校验和恢复；
- contract 演进与 consumer 兼容；
- 观测、容量、成本、kill switch、rollout 和 rollback；
- AI 的模型/prompt/tool/retrieval 版本、Eval 与安全边界。

#### 测试设计

建立 `AC / 风险 → 测试层 → fixture/dataset → 环境 → 判定阈值 → evidence kind` 映射。测试与实现共享同一 mock 不能证明真实集成；breaking checker 不能替代语义兼容；少量主观 prompt 试验不能替代 Eval。

#### Walking skeleton

`controlled` 或跨仓 Feature 在大规模实现前先安排最窄端到端路径：使用最小契约、provider、consumer 和观测接通一条无危险副作用的路径，尽早验证生成、版本 pin、身份、环境和回滚假设。它仍是一个 slice，在 G2 Packet 中有独立 scope，并有自己的证据和 G3；不得用“骨架能跑”跳过剩余验证。

#### Slice 图

每个 slice 写清：目标、允许/禁止范围、依赖、关联 AC/boundary、验证命令、回滚、停止条件和覆盖它的 G2 Authorization Packet ID；多个 Slice 可以引用同一有界 ID。尽量按依赖图组织，避免一个 slice 同时新增契约、migration、API、UI 和启用开关。

#### G2 结论

G2 是对整个 Feature 当前 `build_digest` 的一次有界构建授权，必须覆盖要执行的 slice instance、repository/base SHA、路径、允许/排除 capability、`environment: local_engineering`、数据分类、预算、有效期、所需 evidence、停止条件和重新授权触发器；`account` 保持 `null`，明确不授权真实外部账号。G2 不授权生产、外部写、真实数据、付费调用或不可逆动作，也不代替各 G2C/G3 实例。先通过 G2，再由每个 G2C 逐边界解锁依赖 Slice；生产/预发布账号只能由新的 G5 授权精确绑定。

Repository checkout identity 与 repo 内修改 scope 是两层事实：`identity={kind,name,url,root}` 标识 checkout，且必须精确匹配项目 `.feature-delivery/repository-registry.yaml`。`managed` 是项目根内已登记路径；`external` 是显式登记的单层项目外 checkout。相邻路径可以作为 external 登记，但未登记或隐式推断的目录拓扑、以及多层项目外跳转一律拒绝。`repositories[].path`、`slices[].paths` 与 Authorization `paths` 才表示 repo 内 scope。Slice/Authorization path 使用 `{repository,path}`，拒绝绝对路径、`..`、空段、反斜杠和 glob，且 Authorization 必须精确等于 Slice scope 的并集。`.` 是整仓授权，不是通配符简写：必须写 justification；`controlled` 或 high/critical 风险还必须在 G2 引用 subject 为该 repository 的成功 `exception` Evidence。

## 6. Boundary 交付：每实例 G2C

### 建立实例

对每个受影响 boundary 分别声明：ID、类型、影响分类、Owner、权威源、producer、consumers、支持基线、版本/digest、生成器、fixture 和关联 slice。有 Boundary 时，`04-contract-change-plan.md` 只是索引；每个已声明 Boundary 在 manifest 中引用唯一 `boundary_spec` artifact，路径为 `boundaries/<BND-ID>.md`，通过以下命令建立：

```bash
node <FRAMEWORK_ROOT>/scripts/materialize-boundary.mjs <package> BND-001
```

在运行前，`BND-001.artifact_id` 写约定 forward ref `ART-BOUNDARY-BND-001`。该 ID 暂时尚无 artifact 的中间态必须 fail-closed，不得提交或进入 Gate；materializer 原子创建文件/artifact 并回写同 ID。索引不成为多个 Boundary 的共享规范，一个 artifact 也不能被多个 Boundary 复用。无受影响 Boundary 时，索引不 materialize，不创建假 G2C。

### 兼容证明

- `none`：没有实例，不创建假通过记录；
- `additive`：验证旧 consumer 对新增字段/事件/枚举的容忍和语义；
- `semantic`：即使结构不 breaking，也需人工语义评审和行为测试；
- `breaking`：明确版本策略、迁移窗口、双轨/适配、consumer pin 和退出旧版本条件。

数据库、权限策略、外部 API 和 AI tool schema 同样是 boundary；不要只把 HTTP OpenAPI 当契约。

### G2C 决策

决策绑定一个 boundary 的 `boundary_digest` 和精确 subject。权威源、consumer 基线、generator、digest 或兼容矩阵变化时，该 G2C、引用它的 G3 和后续 G4 变 `stale`；无关 Boundary/Slice 保持独立。G2C 是 Boundary readiness，不扩大 G2 Authorization Packet 的文件、账户或环境权限。

## 7. Slice 实施：每实例 G3

### 7.1 Authorization packet

执行前由有权人确认：

- Feature/slice ID 和有效期；
- 精确 canonical repository identity、branch/base SHA、结构化 repo 内路径与 capability；
- 明确禁止范围；
- 可用环境、账户、数据分类和预算；
- 前置 Gate、contract/digest 和用户已有改动；
- 必须运行的验证及 evidence；
- 停止、升级和失效条件。

范围、SHA、依赖、环境、数据或副作用变化即停止，追加失效记录并申请新 packet。授权包不是“只要有助于完成需求就可以做”的泛化许可。

`allowed_actions` 与 `excluded_actions` 只能取自当前 Feature 绑定的内容寻址 Gate Policy 的 canonical capability enum。有效能力是 packet 允许集与 Gate 的 `permitted_capabilities` 交集，再扣除 `prohibited_capabilities`/显式 excluded 集；自由文本近义词、允许/排除重叠和未进入禁止集的高副作用能力一律 fail-closed。

### 7.2 单切片闭环

```text
复核 subject
  → 建立/运行能揭示错误的测试
  → 最小实现
  → 局部 lint/test/build/generate
  → 完整 diff 与工作区审查
  → 追加 evidence
  → 独立视角 Review
  → G3 决策
```

Review 优先寻找错误结果、越权、数据损坏、不可回滚、契约/migration 顺序、真实路径未验证及测试与实现同源偏差。另一个 Codex 会话可增加独立视角，但仍是 evidence，不是人类批准。

### 7.3 外部状态变化

以下动作必须在执行前取得新的、精确授权，即使 G2/G3 资料已齐：

- 向 Git 远端 push、创建 PR/tag/release；
- 调用真实外部写接口或使用付费服务；
- 访问真实个人/商业敏感数据；
- 部署、改变 feature flag、secret、权限或流量；
- 执行 migration、回填、删除、批量覆盖或其他不可逆动作。

授权必须指明目标、范围、环境、账户、预算、回滚和有效期。无法确认就停止，不以“用户想完成需求”为推定授权。

## 8. G4 Engineering Complete

G4 是工程集成结论，不是各 slice 勾选的简单相加。形成候选 `engineering_digest` 后：

- 固定全部仓库/契约/制品的精确版本；
- 确认所有适用 G2C/G3 仍有效；
- 运行跨 slice 集成、conformance、E2E/Eval、安全和恢复验证；
- 映射每条 Must AC/NFR 与风险到 evidence；
- 复核 diff、生成物、lockfile、migration、工作区和用户已有改动；
- 处置 Review findings；P0/P1 清零，剩余风险有接受记录；
- 更新验证报告；Delivery Summary 不是 G4 输入。

`local_engineering` 在 G4 后结束。G5/G6 由 target policy 派生 `not_applicable`，不在 ledger 追加 N/A decision。G4 有效通过之后才由机器生成交付总结，其 `terminal_subject_digest` 绑定当前 `engineering_digest`，并明确未部署、未验证线上结果。Summary 是派生导航，生成后不手改；主体改变后先追加新 terminal decision，在受审查的变更中移除可由 Git 恢复的旧派生 Summary，再重新 materialize；脚本本身不覆盖已有文件。

## 9. 发布与结果验证

### 9.1 发布 DAG，而非固定顺序

`staging`/`production` 先建立节点和依赖，例如 build、publish contract、consumer tolerant、expand schema、deploy provider、backfill、enable、observe、contract cleanup。实际顺序由安全不变量推导：

- 任一时刻旧/新 reader 与 writer 的兼容组合；
- request producer 不早于 receiver 接受，response/event producer 不早于 consumer 容忍；
- migration/回填可暂停、重试、校验和恢复；
- 不可逆节点前置备份/PITR、审批和停止条件；
- 每节点都有验证、补偿或 roll-forward。

因此不能把 `deploy → migrate`、`migrate → deploy` 或其他固定模板当通用答案。

### 9.2 G5 Release Authorized

G5 subject 包含 `release_digest`、目标环境、目标账号、精确制品、配置/权限、DAG、灰度阶段、指标阈值、观察窗口、kill switch、回滚/前向修复和执行负责人。它的 environment 必须与 Target 一致，`account_ref` 必须等于 authorization account；release/rollback evidence 也必须绑定同一 environment、account 和 artifact refs，rollback ref 指向真实演练 evidence。G5 通过后，每个真实外部动作仍按 authorization packet 执行和留证。

### 9.3 G6 Outcome Verified

发布命令 exit 0 只说明命令返回，不说明服务 ready 或用户结果正确。G6 必须与当前 G5 的 `release_digest`、artifact refs、environment 和 account 精确连续，并基于目标环境真实 evidence：smoke、业务结果、错误/延迟/资源/成本、安全审计、适用 AI 指标、观察窗口及事件处置。所有 G6 Evidence 必须在当前有效 G5 之后；时间链满足 `release_execution.finished_at ≤ smoke.started_at`、`smoke.finished_at ≤ observation/owner_acceptance|outcome_metric.started_at`，且每个实际使用的 kind 分别覆盖全部 AC。未完成观察时状态保持 `pending/in_review`，不得提前关闭。G6 通过后才生成 Summary；Summary 不是 G6 证据。

## 10. Evidence 与 Decision 质量

### Evidence 必须可复现

至少记录：稳定 ID、kind、被验证 subject、repository/cwd、完整命令或工具动作、环境、开始/结束/记录时间、完整代码/制品版本、工具版本、exit code、`passed|failed|not_run` 和日志/artifact 引用。时间必须满足 `started_at ≤ finished_at ≤ recorded_at ≤ 当前合理时间`；被 passed Decision 引用的成功证据必须声明至少一个 immutable URI、digest，且 `retention_until` 不早于 Decision 的 `valid_until`。Evaluator 校验元数据及绑定；URI 可访问性与 artifact bytes/digest 的一致性由受保护 CI/审批面外部核验并出具 receipt。

证据有层级边界：

- lint 不能证明业务行为；
- unit 不能证明跨服务集成；
- mock E2E 不能证明真实依赖；
- breaking check 不能证明语义兼容；
- Review 不能证明测试已执行；
- 部署成功不能证明 outcome。

### Decision 必须绑定 subject

至少记录：稳定 ID、Gate/instance、state、人类 actor、其在 manifest 已分配的真实 roles、时间、分段 subject digest、`evidence_refs`、有效期/失效条件、`attestation` 和适用的 `supersedes`。`passed` 必须让签名 key 的 actor/roles/Gate/Profile/Target/有效期 scope 全部匹配，并验证对“Feature ID + 精确 policy bytes digest + 除 attestation 外完整 Decision”的签名；未签名只算草案。所有 state（不只 `passed`）的 `decided_at` 都不得在未来，非空 `valid_until` 必须晚于 `decided_at`。一个批准只对当前 subject 有效，不能引用“最新版”“当前分支”或浮动 checkout。G3/G4 的 `code_refs` 逐仓包含 `sha + base_sha`；`controlled` G3 的 `static_analysis`，以及 G4 的 `review`、`security_review` 和适用 `data_review`，必须对每个 code ref 精确匹配 repository/code/base，不能用一仓结果覆盖多仓。

避免 SHA 自引用：绑定实现/契约/制品等被判断对象，不要求包含 decision 的治理提交引用自身 SHA。治理提交可以由外部 Git/CI provenance 追踪。

## 11. 变更、失效与重新批准

发生以下变化时先停止受影响工作：需求/AC、设计、风险/Profile、Target、仓库/consumer、boundary 语义、代码 SHA、制品 digest、依赖、环境、授权范围、关键证据或策略。

处理顺序：

1. 更新 `feature.yaml` 当前声明和受影响文档；
2. 在账本追加新 evidence，并追加 `stale` 或带 `supersedes` 的替代 decision；
3. 由 evaluator 计算受影响 Gate/实例为 `BLOCKED` 或可重新送审；
4. 从最早失效 Gate 开始重新批准；
5. 只有新 authorization packet 生效后才继续执行。

不得修改旧账本记录来维持绿色，也不得让后置 Gate 的旧批准遮蔽失效前置。

## 12. Legacy v1

- v1 包只读保留，是历史材料，不是 v2 Gate 证据；
- 项目的 `.feature-delivery/legacy-v1-allowlist.txt` 逐个固定已登记历史包的 basename 与规范化 tree digest（相对路径 + 字节内容，忽略 `.DS_Store`，不依赖 mtime）；全新项目保持 registry 为空；
- 默认 checker 拒绝 v1；`--allow-legacy` 即使精确识别也保持 `valid=false` 和非零退出，只返回 `LEGACY_RECOGNIZED` inventory，不是 Gate PASS；
- 新增 v1、目录改名、普通文件增删/重命名/改写或符号链接都会 fail closed；
- 旧需求若继续开发，创建新 v2 Feature Package，通过只读引用关联旧包；
- 不反向填造过去不存在的 baseline、evidence、decision、SHA 或批准；
- 如需迁移事实，只复制可验证的当前事实并注明来源和重新验证状态。

## 13. Changed-files 与 governance trust

合并检查不能只证明“仓库里存在一个 v2 包”。每个实现路径必须能追到当前 Package、G2 Authorization 的 repository/path/base ref，以及命中最具体 Slice scope 的有效 G3；项目策略还可以要求 G4。Feature Package 内只允许 core 文件和 manifest artifacts，未声明路径与重复 `feature.id` 都必须 fail closed。

远端 enforcement 必须从受保护 base 读取 verifier、Schema、Gate Policy、coverage policy 和 approval trust root，不能执行候选变更中的脚本。Evidence/Decision 历史必须逐提交验证 append-only，而不是只比较最终文件。候选代码不能用自己新增的 policy、key、exemption 或 verifier 自证。

审批 trust root、CI adapter、framework scripts/schemas、active/versioned policies、repository registry、legacy registry 和依赖锁属于治理 TCB。TCB 变更必须隔离，并由待审变更不可写的第二通道批准精确 change-set digest；普通 Feature Gate 或代码审查不能替代该通道。

上述原则是核心要求。当前 Git commit/tree/diff 算法见 [integrations/git.md](integrations/git.md)；GitHub App、required status、Environment、branch protection、bootstrap 和 merge queue 限制见 [integrations/github-actions.md](integrations/github-actions.md)。复制 adapter 文件不等于 enforcement 已上线，管理员必须完成外部配置并验证故障时 fail closed。

## 14. 可以使用的完成用语

必须按证据精确表达：

- “结构校验通过，Gate 尚未批准”；
- “G3/SLC-001 已通过，SLC-002 仍 blocked”；
- “G4 Engineering Complete，Target 为 local_engineering，未发布”；
- “G5 已批准，尚未执行发布”；
- “已部署，G6 观察中”；
- “G6 Outcome Verified，Feature 可关闭”。

禁止只写“完成”“生产就绪”“全部绿色”而不给 Target、Gate、instance、subject 与 evidence。
