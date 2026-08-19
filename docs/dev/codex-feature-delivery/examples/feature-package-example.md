# V2 示例：按状态筛选工作项

> **Purpose**：展示一个虚构的 `standard + local_engineering` Feature 如何声明多仓 Boundary、Slice、Evidence 与 Decision。
>
> **Authority**：本文是教学快照，不是批准记录，也不是可复制的完整物理 Package；字段以当前 policy、Schema 和模板为准。
>
> **完成时点**：G2 已通过，G2C 已具备决策条件但尚未批准。

## 1. 场景与物理形态

`FEAT-204` 让具有 `work-item:read` 权限的成员按 `running|succeeded|failed` 筛选工作项；未提供筛选值时保持原有行为。项目由以下虚构仓库组成：

- `example-app`：当前 Feature Package 所在仓库；
- `example-contracts`：以 `../example-contracts` 显式登记的外部 sibling 契约权威仓；
- `example-service`：以 `../example-service` 显式登记的外部 sibling 服务端 producer；
- `example-client`：以 `../example-client` 显式登记的外部 sibling 客户端 consumer。

三个 sibling 均使用 `identity.kind: external`；`root` 只能是单层 `../<name>`，且运行时必须验证 `<name>` 与 `identity.name` 完全一致。若项目改用 monorepo/managed registry，应把 `kind` 改为 `managed`，并使用项目根内的安全 POSIX 相对路径，不得沿用这里的 `../` root。

真实目录由生成器创建。此快照包含 core ledgers、适用的 `00`–`08` 文档与独立 `boundaries/BND-001.md`。`09-release-and-rollback.md` 因 target 为 `local_engineering` 而不适用；`10-delivery-summary.md` 仅在终点 G4 通过后生成。

本文只展示关键片段，不能作为新的需求包直接复制。

## 2. `feature.yaml` 关键声明

```yaml
schema_version: 2
kind: FeaturePackage
policy:
  id: codex-feature-delivery/v2
  version: 2.0.0
  digest: "sha256:d55f4d0a53d2f7170b16bc84bcfca7c7c97aaa6a3791b2ce32f8561edac6bcfb"

feature:
  id: FEAT-204
  slug: work-item-status-filter
  title: 按状态筛选工作项
  summary: 成员可选择允许状态并获得权限边界内的筛选结果
  lifecycle: active
  profile: standard
  delivery_target: local_engineering
  created_at: 2026-01-15
  updated_at: 2026-01-15
  owners:
    accountable: example.owner
    role_assignments:
      - actor: example.owner
        roles: [accountable_owner, requirement_owner]
      - actor: example.technical
        roles: [technical_owner, contract_owner]
      - actor: example.verifier
        roles: [verifier, reviewer]

classification:
  risk: medium
  data: internal
  risk_factors: [contract_change]

size:
  class: medium
  repositories: 4
  boundaries: 1
  acceptance_criteria: 3
  slices: 5
  estimated_active_days: 2

acceptance_criteria:
  - {id: AC-001, statement: 筛选结果仅包含权限边界内指定状态的工作项且保持分页语义}
  - {id: AC-002, statement: 未提供 status 时行为与当前列表一致}
  - {id: AC-003, statement: 非法 status 返回稳定错误且不执行查询}

repositories:
  - id: app
    identity: {kind: current, name: example-app, url: "https://example.invalid/acme/example-app.git", root: "."}
    path: src
    root_scope_justification: null
    root_scope_exception_evidence_id: null
    role: package_owner
    baseline: {sha: 4444444444444444444444444444444444444444, evidence_id: EV-BASE-APP-001}
  - id: contracts
    identity: {kind: external, name: example-contracts, url: "https://example.invalid/acme/example-contracts.git", root: "../example-contracts"}
    path: api
    root_scope_justification: null
    root_scope_exception_evidence_id: null
    role: authority
    baseline: {sha: 3333333333333333333333333333333333333333, evidence_id: EV-BASE-CONTRACTS-001}
  - id: service
    identity: {kind: external, name: example-service, url: "https://example.invalid/acme/example-service.git", root: "../example-service"}
    path: src
    root_scope_justification: null
    root_scope_exception_evidence_id: null
    role: producer
    baseline: {sha: 1111111111111111111111111111111111111111, evidence_id: EV-BASE-SERVICE-001}
  - id: client
    identity: {kind: external, name: example-client, url: "https://example.invalid/acme/example-client.git", root: "../example-client"}
    path: src
    root_scope_justification: null
    root_scope_exception_evidence_id: null
    role: consumer
    baseline: {sha: 2222222222222222222222222222222222222222, evidence_id: EV-BASE-CLIENT-001}

boundaries:
  - id: BND-001
    type: generated_schema
    impact: additive
    owner: example.technical
    authority: example-contracts@3333333333333333333333333333333333333333:api/work-item.openapi.yaml
    producers: [service]
    consumers: [client]
    known_unknowns: [旧 consumer 忽略可选参数, 未知 enum 使用稳定错误 envelope]
    artifact_id: ART-BOUNDARY-BND-001

slices:
  - id: SLC-001
    title: 状态 enum 与纯验证规则
    outcome: 非法状态在访问数据源前失败
    depends_on: []
    boundary_ids: []
    acceptance_criteria: [AC-003]
    repositories: [service]
    paths: [{repository: service, path: src}]
    authorization_decision_id: DEC-G2-001
  - id: SLC-002
    title: Contract First 参数与生成兼容检查
    outcome: 权威契约声明可选 status 且生成物通过兼容校验
    depends_on: []
    boundary_ids: [BND-001]
    acceptance_criteria: [AC-002, AC-003]
    repositories: [contracts]
    paths: [{repository: contracts, path: api}]
    authorization_decision_id: DEC-G2-001
  - id: SLC-003
    title: 服务端筛选
    outcome: 服务仅返回权限边界内的匹配工作项
    depends_on: [SLC-001, SLC-002]
    boundary_ids: [BND-001]
    acceptance_criteria: [AC-001, AC-002, AC-003]
    repositories: [service]
    paths: [{repository: service, path: src}]
    authorization_decision_id: DEC-G2-001
  - id: SLC-004
    title: 客户端筛选交互
    outcome: 用户可选择和清除筛选
    depends_on: [SLC-003]
    boundary_ids: [BND-001]
    acceptance_criteria: [AC-001, AC-002]
    repositories: [client]
    paths: [{repository: client, path: src}]
    authorization_decision_id: DEC-G2-001
  - id: SLC-005
    title: 应用集成
    outcome: 当前应用组合 service 与 client 版本并验证关键用户路径
    depends_on: [SLC-003, SLC-004]
    boundary_ids: [BND-001]
    acceptance_criteria: [AC-001, AC-002, AC-003]
    repositories: [app]
    paths: [{repository: app, path: src}]
    authorization_decision_id: DEC-G2-001

# 完整 manifest 还包含 dependencies 和所有 core artifact；此处仅展示条件项。
artifacts:
  - {id: ART-CONTRACT, kind: contract_change_plan, path: 04-contract-change-plan.md, authority: index, applicability: required, reason: boundaries_present}
  - {id: ART-BOUNDARY-BND-001, kind: boundary_spec, path: boundaries/BND-001.md, authority: normative, applicability: required, reason: boundary_BND-001}
  - {id: ART-RELEASE, kind: release_and_rollback, path: 09-release-and-rollback.md, authority: normative, applicability: not_applicable, reason: local_engineering_target}
  - {id: ART-SUMMARY, kind: delivery_summary, path: 10-delivery-summary.md, authority: summary, applicability: conditional, reason: materialize_after_terminal_gate}
```

## 3. Evidence 与 Decision 索引

实际 ledger 必须保存完整 subject、命令、工具版本、时间、不可变 artifact URI 和 digest。命令与工具来自项目根 `.feature-delivery.yaml.tooling`，本示例不假设任何语言、包管理器或测试框架。

| Evidence ID | kind | subject/result | 用途 |
|---|---|---|---|
| `EV-BASE-CONTRACTS-001` | baseline | `contracts@333…333 / passed` | G2 契约权威基线 |
| `EV-BASE-SERVICE-001` | baseline | `service@111…111 / passed` | G2 producer 基线 |
| `EV-BASE-CLIENT-001` | baseline | `client@222…222 / passed` | G2 consumer 基线 |
| `EV-BND-001` | boundary_validation | `BND-001 / passed` | 使 G2C 具备决策条件，不自动批准 |

| Decision ID | Gate/instance | state | 绑定与授权 |
|---|---|---|---|
| `DEC-G0-001` | `G0/feature` | passed | 当前 `intake_digest`；允许影响分析 |
| `DEC-G1-001` | `G1/feature` | passed | 当前 `scope_digest`；允许设计与测试计划 |
| `DEC-G2-001` | `G2/feature` | passed | 当前 `build_digest`、逐仓 baseline 与精确 Slice path；禁止 deployment |

每条 `passed` Decision 都必须由 `approval-trust.yaml` 中授权给对应 actor、角色、Gate、Profile 和 Target 的 Ed25519 key 签名。示例省略 signature 和 payload digest，不能据此构造真实账本。契约唯一权威是 `example-contracts` 的不可变 commit/path ref；service 与 client 不维护影子契约。

## 4. Evaluator 状态示意

```text
VALID: FEAT-204 profile=standard target=local_engineering
GATE G0 instance=feature state=passed eligibility=ELIGIBLE decision=DEC-G0-001
GATE G1 instance=feature state=passed eligibility=ELIGIBLE decision=DEC-G1-001
GATE G2 instance=feature state=passed eligibility=ELIGIBLE decision=DEC-G2-001
GATE G2C instance=BND-001 state=pending eligibility=ELIGIBLE decision=none
GATE G3 instance=SLC-001 state=pending eligibility=BLOCKED decision=none
  - SLC-001 缺少成功测试 Evidence
GATE G3 instance=SLC-002 state=pending eligibility=BLOCKED decision=none
  - 前置 G2C/BND-001 未通过（pending）
GATE G3 instance=SLC-003 state=pending eligibility=BLOCKED decision=none
  - 前置 G2C/BND-001 未通过（pending）
GATE G3 instance=SLC-004 state=pending eligibility=BLOCKED decision=none
  - 前置 G3/SLC-003 未通过（pending）
GATE G3 instance=SLC-005 state=pending eligibility=BLOCKED decision=none
  - 前置 G3/SLC-003、G3/SLC-004 未通过（pending）
GATE G4 instance=feature state=pending eligibility=BLOCKED decision=none
GATE G5 instance=feature state=not_applicable eligibility=NOT_APPLICABLE decision=none
GATE G6 instance=feature state=not_applicable eligibility=NOT_APPLICABLE decision=none
```

`VALID` 只表示结构有效；`ELIGIBLE` 只表示可以由 Gate Owner 决策。Evaluator 不代替人类批准。下一步是追加绑定当前 `boundary_digest[BND-001]` 的 G2C Decision，再分别实施和验收 Slice。
