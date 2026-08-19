# {{FEATURE_ID}} 交付总结

> **Purpose**：在目标终点通过后留下稳定结果与 ledger 导航。
>
> **Authority**：frontmatter 与正文导航都由 materializer 派生；frontmatter 绑定 terminal decision/digest，正文非权威且不是 Gate 证据。
>
> **适用 Profile / Target**：全部 Profile 与 Target。
>
> **完成时点**：仅在终点通过后 materialize：`local_engineering → G4`，`staging/production → G6`。

初始 package 将本文件声明为 `conditional` 且允许缺席；终点未通过时不得预建总结冒充关闭。`local_engineering` 的 `terminal_subject_digest` 是当前 G4 `engineering_digest`，`delivery_claim` 是 `engineering_complete_not_released`；`staging|production` 是当前 G6 `release_digest` 与 `target_outcome_verified`。

生成后不得手改本文件。若 terminal subject 变化，先在 ledger 追加新 terminal decision，再重新 materialize；生成器采用不覆盖策略，必须依赖明确的历史保留/替代流程。

生成的 frontmatter 必须包含且只由 materializer 赋值：`schema_version`、`kind`、`feature_id`、`delivery_target`、`terminal_gate`、`terminal_decision_id`、`terminal_decision_digest`、`terminal_subject_digest`、`delivery_claim`、`generated_at` 和 `summary_body_digest`。`terminal_decision_digest` 绑定完整 terminal Decision 记录；evaluator 会从 manifest/ledger 重建正文并逐字比较，任何手改都使 strict 闭环失效。

## 1. 稳定结果

- 原目标、最终可观察行为、用户/权限边界与未交付非目标：{{DELIVERED_OUTCOME}}
- 使用、维护与验证入口：{{OPERATING_ENTRYPOINTS}}
- 核心 Evidence IDs 与可重放入口：{{TERMINAL_REFS}}

`local_engineering` 只总结工程完成，不声称 staging/production 结果；G5/G6 由 target policy 派生 `not_applicable`，不存在 N/A decision。

## 2. 追踪与导航

| Claim/Boundary/Subject | 最终语义 | Slice/Test | Evidence/Artifact refs |
|---|---|---|---|
{{DELIVERY_TRACE_ROWS}}

这里只引用 Evidence/Decision ID，不复制 command result、full SHA、digest 或 Gate 状态。`not_run`、过期或主体不匹配的证据不能进入已覆盖映射。

## 3. 指标与控制

- 指标定义/query、baseline/outcome Evidence 与稳定结论：{{METRIC_REFS_AND_CONCLUSIONS}}
- 安全、数据、审计控制及复查触发：{{CONTROL_REFS_AND_TRIGGERS}}

指标必须能从 ledger 制品复算并包含分母、窗口与环境。没有观测不能写成零事件或目标达成。

## 4. 限制与后续

- 事件/恢复经验、已知限制、接受风险及有效 Decision ID：{{RISKS_AND_LEARNINGS}}
- 独立 follow-up、清理条件、Owner 与跟踪入口：{{FOLLOW_UPS}}
- 最终文档/Runbook/API/Changelog 导航：{{HANDOFF_REFS}}

移除旧契约/列/兼容路径、临时 Flag 或例外必须在消费者迁移与目标环境证据满足后单独授权，不能借已关闭 Feature 继续修改。

## 5. 权威导航

- 当前声明：`feature.yaml`
- 原始事实：`evidence.yaml`
- Gate/授权/例外：`decisions.yaml`
- 工程索引：`08-verification-report.md`
- staging/production 计划：`09-release-and-rollback.md`

若摘要与 ledger 冲突，以 evaluator 的有效主体判定为准。terminal decision/digest 变化后旧 Summary 失效；在新终点决策通过并按治理流程保留/迁移旧文件后重新 materialize。脚本不覆盖目标，不用手写 frontmatter 伪造闭环。
