# Quality Gates v2

本文定义核心 Gate 断言，不规定项目目录、仓库拓扑或 CI provider。项目接入参数见 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)。

Gate 是对精确对象的可审计决策，不是 Markdown 勾选框。清单帮助发现缺口，evaluator 判断是否具备决策条件，`decisions.yaml` 中的有效记录才决定 Gate 状态。

## 状态与判定

Gate 状态仅允许：

| 状态 | 含义 |
|---|---|
| `pending` | 尚未准备或尚无判断 |
| `blocked` | 已知前置、事实或授权缺失 |
| `ready` | 资料具备，可送审；未批准 |
| `in_review` | 有权人正在审查；未批准 |
| `passed` | 有效决策批准了当前精确 subject |
| `failed` | 验证或有权决策未通过 |
| `stale` | 曾有决定，但 subject、证据、依赖、策略或有效期已变化 |
| `not_applicable` | 由 policy 对 Target/实例派生，不由 Feature 包追加 N/A decision |

evaluator 对适用 Gate 只输出：

- `ELIGIBLE`：结构、前置、证据和适用性满足，可以由有权人决定；
- `BLOCKED`：存在明确缺口，不能批准或旧批准已失效。

被 Target policy 裁剪的 Gate 输出 `NOT_APPLICABLE`，不接受包内 N/A Decision。

`ELIGIBLE` 不等于 `passed`。证据结果 `not_run`、计划中的命令、占位值、退出码缺失、脏/浮动引用、Codex 总结和 Review 文本都不能产生绿色。

## Subject digest 分段

| Gate | 决策必须绑定 | 失效范围 |
|---|---|---|
| G0 | `intake_digest` | Intake 声明或 Brief 变化 |
| G1 | `scope_digest` | 需求、影响、规模或 Boundary 声明变化 |
| G2 | `build_digest` | Scope、baseline/依赖当前状态、设计/测试/Slice 计划变化 |
| G2C | `boundary_digest[instance]` | 该 Boundary 声明或独立规范变化 |
| G3 | `slice_digest[instance]` + code refs | 该 Slice、其前置 Slice/Boundary 或代码变化 |
| G4 | `engineering_digest` + code refs | 集成候选、实例集或工程证据变化 |
| G5/G6 | `release_digest` + code/engineering-decision/artifact/environment/account refs | 当前 G4、代码、制品、目标环境或发布/恢复计划变化 |

digest 按实例隔离：某个 Boundary 变化不应让无关 Boundary/Slice 一起失效。G3 还必须等待 `slice.depends_on` 中所有前置 Slice 的 G3 有效通过。

## Gate 实例与前置

```text
G0 → G1 → G2 → G2C[每个适用 boundary] → G3[每个 slice] → G4 → G5 → G6
```

- 全局 Gate：G0、G1、G2、G4、G5、G6。
- 实例 Gate：G2C 的 instance 是 boundary ID；G3 的 instance 是 slice ID。
- `local_engineering` 的终点是 G4；G5/G6 由 target policy 派生 `not_applicable`，不追加 N/A decision。
- `staging` 与 `production` 的终点是 G6。
- 后置 Gate 不能掩盖缺失前置；任一适用前置变为 `stale/failed/blocked`，依赖决策随之失效。
- Markdown 完成度按 Gate 展开；未到阶段的占位不阻塞早期 Gate。`--strict` 和 `lifecycle: completed` 则要求全部适用 Gate、已到期文档与终点 Summary 闭环。

## G0 — Intake Accepted

**Subject**：`intake_digest`，覆盖 Feature 身份、问题、初始范围、Profile、Target、Owner 与安全边界。

批准前必须证明：

- Feature ID、标题、Owner、目标、非目标存在；
- Profile 和 Target 显式选择且组合合法；
- 数据分类、真实账户、外部写、费用和不可逆风险已有初始声明；
- 未知项、禁止动作和调查权限明确；
- artifact manifest 与当前路由规则一致。

失败处理：只允许补 Intake 和无副作用调查，不允许业务代码修改。

## G1 — Scope Ready

**Subject**：`scope_digest`，覆盖需求版本、AC/NFR、影响图、size/dependency 评估和边界清单。

批准前必须证明：

- Must 需求有编号化、可判定 AC，失败/权限/边界语义明确；
- 逐仓 baseline 命令、运行范围与已有改动保护方式已确定；真实结果最迟在 G2 前记录；
- producer、consumer、数据、权限、外部系统和 AI boundary 已建实例；
- size、依赖、关键路径和拆分结论明确；过大需求已拆 Epic/Feature；
- Profile 与风险相符，缺失事实不会被默认补成业务规则。

失败处理：继续只读调查或缩小范围。

## G2 — Build Authorized

**Subject**：`build_digest`，覆盖批准的 Scope、设计版本、切片图、验证计划以及当前 baseline/依赖状态。

批准前必须证明：

- 重大选项有决策 ID，阻塞问题关闭；
- 技术设计覆盖状态、失败、安全、数据、兼容、观测与恢复；
- AC/风险映射到可重复验证，明确 `not_run` 的处理；
- 每个 slice 可独立验证、回滚，且有授权模板和停止条件；
- baseline、size、依赖和工作区事实仍新鲜；
- `controlled` 或跨仓需求先安排 walking skeleton，避免末期才集成。
- Repository identity 的 `kind/name/url/root` 必须匹配项目 `.feature-delivery/repository-registry.yaml`：`managed` 是项目根内登记路径，`external` 是显式登记的单层项目外 checkout；未登记/隐式拓扑和多层项目外跳转拒绝。repo 内 path 不含绝对路径、`..`、空段、反斜杠或 glob。
- Authorization Packet 以 `{repository,path}` 精确覆盖全部 Slice scope 和逐仓 base refs；canonical capability 允许集与策略允许集取交集，禁止集完整且无重叠。
- `.` 整仓 scope 有显式 justification；`controlled`/high/critical 还引用逐仓成功 `exception` Evidence。
- `controlled` 在 G2 前规划逐仓 static/security review 与适用 data review；实际 `static_analysis` 在 G3、`security_review` 和受限数据 `data_review` 在 G4 生成并精确绑定对应 code/base。

G2 先对整个 Feature 授权执行已声明的有界构建计划；不自动授权外部写、真实数据、付费调用、部署、migration 或不可逆动作。后续 G2C 只逐 Boundary 解锁依赖它的 Slice，不扩大 G2 授权。

## G2C — Boundary Ready（每个 boundary）

**Subject**：一个 boundary 的 `boundary_digest`、语义版本、权威源、producer/consumer 基线和演进计划。

对 `--instance <boundary-id>` 分别证明：

- boundary 类型和影响分类明确；
- 唯一权威源、Owner、producer、全部已知 consumer 和数据方向明确；
- 兼容矩阵、版本/digest、生成器和不可变 pin 可验证；
- additive、semantic、breaking 的实际风险由相应测试与人工语义审查覆盖；
- 发布 DAG 中的兼容不变量与恢复路径明确。
- manifest 中 `artifact_id` 指向该 Boundary 独占的 `boundaries/<BND-ID>.md`，而不是共享索引。

无边界影响时不是创建一个总 G2C 假通过，而是在 manifest 中无适用实例。`04-contract-change-plan.md` 只是 Boundary 索引，不进入任一 Boundary 的规范权威链。任何 boundary subject 改动都会使其 G2C、依赖 slice 及后续集成决策 `stale`，不使无关实例过期。

## G3 — Slice Accepted（每个 slice）

**Subject**：一个 slice 的 `slice_digest`、精确代码/制品 refs、授权包和验证证据。

对 `--instance <slice-id>` 分别证明：

- authorization packet 在范围、期限和失效条件内，执行对象未漂移；
- 只修改允许仓库/路径，没有吞并用户改动或无关重构；
- 测试、lint/build/generate 等适用命令有真实 evidence；
- 完整 diff、生成物、依赖、migration、安全和日志已按风险审查；
- 验收映射和残余风险已更新，失败/未执行项未被涂绿；
- 新发现的外部副作用已停止并取得新授权。
- `slice.depends_on` 中每个前置 Slice 的 G3 有效，code refs 恰好覆盖该 Slice 声明的 repository，并逐仓带完整 `sha + base_sha`。
- 引用的成功测试 evidence 与同一 repository/code/base 一致，并覆盖该 Slice 声明的 AC；`controlled` 的 static analysis 同样逐仓覆盖。

G3 不是“Codex 说切片完成”，也不是一次全局签字覆盖全部切片。

## G4 — Engineering Complete

**Subject**：`engineering_digest + code_refs + evidence_refs`。digest 覆盖全部适用 G2C/G3、build 与 08；独立 refs 绑定全 repository 最终代码、共同 base 和工程验证集。

批准前必须证明：

- 所有 Must AC/NFR 已映射到实现和证据；
- 全部适用 G2C/G3 有效，集成、conformance、E2E/Eval 等按风险完成；
- 安全、数据、失败和恢复路径完成验证；
- Review findings 已处置；Codex Review 仅作为证据，未替代批准；
- 最终 diff、工作区、制品来源和文档一致，无未知变更；
- 每个 repository 的 review Evidence 都同时匹配 G4 code ref 的 `code_sha/base_sha`；`controlled` 的 security review 与适用 data review 采用同样的逐仓约束；
- 每个 repository 至少一条最终测试 Evidence 同时匹配 G4 的 `code_sha/base_sha`，不能用旧 G3 测试拼接新的集成 SHA；
- P0/P1 清零，其他风险有 Owner、期限和接受记录。

`local_engineering` 到此完成。Delivery Summary 不是 G4 输入；G4 有效通过后才 materialize，并以 `engineering_digest` 作为 `terminal_subject_digest`，明确“工程完成、未发布”。

## G5 — Release Authorized

**Subject**：`release_digest + code_refs + engineering_decision_ref + artifact/environment/account/rollback refs`。digest 覆盖 engineering 与 09；独立 refs 精确继承当前 G4 并绑定发布主体。

批准前必须证明：

- 制品 version、完整 commit、digest、来源和供应链信息可追溯；
- 每仓 `release_artifact` Evidence 同时绑定当前 G4 的 `code_sha/base_sha` 与本次 artifact refs；G5 时间晚于该 G4；
- 发布步骤是依赖 DAG，每个节点有前置、验证、停止和补偿；
- 顺序由兼容/数据安全不变量推导，而非固定 `deploy → migrate`；
- migration/回填可暂停恢复，备份/PITR、roll-forward 与不可逆点明确；
- 灰度、指标、阈值、观察窗口、kill switch 和责任人可执行；
- 目标环境的 secret、权限、容量和外部依赖由真实事实确认；
- 对精确环境与动作已有新授权。
- environment ref 精确等于 Target，`account_ref` 精确等于 G5 authorization account；artifact refs 由同环境、同账号的制品 evidence 覆盖，rollback ref 指向同一主体的成功演练 evidence。

发布、migration、真实数据或付费外部调用仍按节点请求授权；G5 不等于 Codex 获得无限外部操作权。

## G6 — Outcome Verified

**Subject**：与当前 G5 完全连续的 `release_digest`、`code_refs`、`engineering_decision_ref`、artifact/environment/account refs，以及观察窗口和业务/技术结果。

批准前必须证明：

- 目标环境 smoke、关键用户结果和安全抽查有真实 evidence；
- 成功率、错误率、延迟、资源、成本与适用 AI 指标满足阈值；
- 发布事件、回滚、数据异常和审计记录已处置；
- 文档、runbook、清理项、Owner 与期限已登记；
- 实际交付范围与 `feature.yaml` 和制品一致。
- `release_execution`、`smoke`、`observation` 与最终 `owner_acceptance|outcome_metric` 均晚于当前有效 G5；时间链满足 `release_execution.finished_at ≤ smoke.started_at`、`smoke.finished_at ≤ observation/acceptance.started_at`；每个实际使用的 kind 分别覆盖全部 AC。
- 上述每条 Evidence 的 environment、account 和 release artifact refs 都与当前 G5 精确连续。

失败处理：保持“已发布/观察中”或回滚/前向修复，不得关闭 Feature。G6 有效通过后才 materialize Summary，因此 Summary 绝不能是 G6 前置。

## 决策有效性与失效

有效 `passed` 至少要求：Gate/instance 存在且匹配；actor 为可追溯人类，roles 是其在 manifest 已分配角色的子集并满足 Gate 要求；包外 trust root 的有效 Ed25519 key 对完整 Decision 验签，且 key scope 覆盖 actor/roles/Gate/Profile/Target；分段 subject 精确；引用 evidence 存在、成功、时间序合理，且有 digest/保留期覆盖的持久 artifact；前置 Gate 有效、未过期、无后续 invalidation。未签名或只自报 `human` 的记录不能成为绿色。

以下任一变化必须将相关决策视为 `stale`：需求/设计版本、代码 SHA、制品 digest、boundary 语义、consumer 基线、依赖、环境、授权范围、风险/Profile/Target、关键 evidence 或 Gate 策略。做法是追加 invalidation/replacement 记录并重新判断；不得改写旧 decision 以抹去历史。
