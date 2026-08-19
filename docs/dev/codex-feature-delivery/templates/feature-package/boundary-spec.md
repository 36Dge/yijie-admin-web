# {{FEATURE_ID}} / {{BOUNDARY_ID}} — Boundary 规范

| 元数据 | 值 |
|---|---|
| Purpose | 为一个 Boundary 定义权威源、稳定语义、支持基线和可撤回演进 |
| Authority | 本文是该 Boundary 的 normative spec；当前 ID/type/impact/artifact 声明以 `feature.yaml` 为准 |
| 适用范围 | 仅 `{{BOUNDARY_ID}}`，不可复用于其他 Boundary |
| 完成时点 | 对应 G2C 决策前；语义或支持基线变化时重新评估 |

> 实际检查只进 `evidence.yaml`，G2C 决策只进 `decisions.yaml`。本文不声明当前 Gate 状态，也不扩大 G2 Authorization Packet。

## 1. 身份与权威链

| 字段 | 值 |
|---|---|
| Boundary ID / type / impact | `{{BOUNDARY_ID}}` / `{{BOUNDARY_TYPE}}` / `{{BOUNDARY_IMPACT}}` |
| Owner | {{BOUNDARY_OWNER}} |
| 唯一权威源 | {{BOUNDARY_AUTHORITY}} |
| Producer(s) | {{BOUNDARY_PRODUCERS}} |
| 已知且受支持 Consumer(s) | {{BOUNDARY_CONSUMERS}} |
| 已知未知项 | {{BOUNDARY_KNOWN_UNKNOWNS}} |
| Generator/runtime 与不变 pin | {{BOUNDARY_GENERATOR_AND_PINS}} |
| 发现/基线 Evidence IDs | {{BOUNDARY_DISCOVERY_AND_BASELINE_REFS}} |

权威源仅允许 `generated_schema|handwritten_protocol|database_format|runtime_third_party|semantic_only` 对应的真实位置。生成 DTO/SDK、handler 类型、ORM、截图或手工副本不得成为影子权威源。

## 2. 语义与支持基线

{{BOUNDARY_SEMANTICS_AND_SUPPORT_BASELINE}}

分别说明请求/输入、响应/事件/存储、默认值、错误、权限/租户、幂等、顺序、重复和未知值的稳定语义。列出支持基线、兼容窗口、已知 consumer 和明确不支持范围；“未发现”不得外推为“无 consumer”。

## 3. 双向兼容矩阵

| Producer | Consumer | 结构结论 | 语义结论 | Test/Evidence ID | 处置 |
|---|---|---|---|---|---|
{{BOUNDARY_COMPATIBILITY_ROWS}}

至少判定 old producer + new consumer 与 new producer + old consumer。输入由 receiver 先接受、sender 后产生；输出/事件由 consumer 先容忍、producer 后产生。Breaking 必须版本化或分阶段迁移；结构 checker 不能代替语义审查。

## 4. 演进 DAG 与恢复

| Step | 动作/不变量 | Requires | 完成判据 | Stop | Undo / roll-forward |
|---|---|---|---|---|---|
{{BOUNDARY_EVOLUTION_DAG_ROWS}}

根据真实 reader/writer、producer/consumer 兼容关系建图，不固定套用 `deploy → migrate`。数据 Boundary 需覆盖 expand/backfill/switch/contract、暂停/重试/校验与不可逆点；外部或 AI tool Boundary 需覆盖版本 pin、限额、拒绝/降级和审计。

## 5. 验证与 G2C 输入

| Claim/Risk | 命令/workflow ref | Oracle | Environment | Evidence kind/ID |
|---|---|---|---|---|
{{BOUNDARY_VERIFICATION_ROWS}}

计划不等于执行。G2C 引用的成功 evidence 必须绑定本 Boundary 当前主体，时间序合理，并声明带 immutable URI、digest 与未过期保留期的 artifact；URI/bytes 可读性由受保护 CI/审批面核验。最终 G2C decision 绑定 evaluator 计算的 `boundary_digest[{{BOUNDARY_ID}}]`，不绑定浮动分支或“最新 schema”。
