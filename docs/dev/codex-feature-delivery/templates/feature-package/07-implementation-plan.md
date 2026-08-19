# {{FEATURE_ID}} 实施计划

> **Purpose**：把 Feature 拆成可独立验收和撤销、并被有界 G2 授权明确覆盖的纵向 Slice。
>
> **Authority**：本文定义稳定范围与依赖；当前授权、Gate、SHA 和证据只在 manifest/ledgers。
>
> **适用 Profile / Target**：全部 Profile 与 Target。
>
> **完成时点**：G2 前；每个 Slice 开工前确认它仍被当前有效 G2 Authorization Packet 覆盖。

本文进入 G2 `build_digest`。G2 先以一个有界 Authorization Packet 授权整个 Feature 中明确列出的 Slice；随后 G2C 逐 Boundary 解锁依赖 Slice，G3 逐 Slice 验收实现。

## 1. 粒度与顺序

- 单一用户结果及最小边界：{{FEATURE_GRAIN}}
- 依赖 DAG：{{DEPENDENCY_DAG}}

Epic、路线图或“完成整个模块”必须先拆为多个 Feature。Slice 应纵向产生可观察增量，不能只按 controller/service/database 横切。首个 Slice 优先成为 Walking Skeleton，真实贯通关键端口；mock 只能位于明确端口后且不得进入目标路径。

## 2. Slice 计划

| Slice | 用户增量与 AC | Boundary/Repo | 允许/禁止范围 | 前置 | Test IDs | 撤销策略 |
|---|---|---|---|---|---|---|
{{SLICE_ROWS}}

按需增行。每个 Slice 对应独立 `G3/<SLICE_ID>`；一个 Slice 的证据或通过不能替代另一个。实际 diff 越界、夹带重构/升级/格式化或依赖未声明时必须停止。

跨仓 producer/consumer 的版本 pin、兼容窗口和更新顺序，以及数据 expand/backfill/switch/contract 的真实依赖，都写进上表或 DAG；不得预设固定流水线。

## 3. Slice 执行边界

每次 Codex 实施任务引用 `decisions.yaml` 中当前有效、已由包外 trust root 验签的 G2 Decision ID，并从该有界 Packet 选择一个已授权 Slice 执行。一个 G2 Packet 可以覆盖多个明确列出的 Slice；不因此增加一轮逐 Slice 人工批准。执行提示至少带出：

```yaml
slice: {{SLICE_ID}}
objective_and_inputs: {{OBJECTIVE_AND_INPUTS}}
repository_and_base: {{REPOSITORY_AND_BASE_CONSTRAINT}}
allowed_and_excluded: {{ALLOWED_AND_EXCLUDED_ACTIONS}}
verification_and_handoff: {{VERIFICATION_AND_HANDOFF}}
expiry_and_invalidation: {{EXPIRY_AND_INVALIDATION}}
```

至少在 base/spec/Boundary/风险/数据分类/允许路径/依赖主体改变或授权过期时重新授权。Codex 产品级 sandbox/approval 不等于项目 G2/G3/G5 授权。

G2 Packet 必须以 `{repository,path}` 精确覆盖全部已授权 Slice scope，列出每仓 base ref、与 `{{DELIVERY_TARGET}}` 相符的工程环境、`account: null`、data/budget、policy enum 中的 allowed/excluded capabilities、required evidence、stop conditions 和 `reauthorize_on`。`account: null` 表示它不授权任何真实外部账号；发布目标账号只能在新的 G5 授权中精确绑定。`.` 整仓 scope 需要 justification；`controlled`/高风险还需逐仓 exception Evidence。

## 4. Review 与合并

- 每个仓库分别记录 base/head、验证和 review；review 证据必须绑定精确 base/head；
- commit 或 PR 数量不代表完成；只有有效证据和 `G3/<SLICE_ID>` 决策能形成通过；
- 合并、部署、迁移、回填和激活是不同动作，分别按 DAG 授权；
- 单人可承担多个角色，但实现、review 与决策记录仍需分开，不伪造独立人员。

## 5. 变更控制与 G3

用户行为/AC 变化回到 requirements；仓库/Boundary 变化回到 impact/contract；风险/数据/架构变化回到 risks/design/test；验证阈值变化回到 test plan。只追加新 Decision/Evidence，不改写历史。

Evaluator 对每个 G3 实例检查：授权对当前 `slice_digest` 仍有效，前置 Slice 已通过，code refs 逐仓携带 `sha + base_sha` 并与成功测试 evidence 一致，AC 被覆盖；controlled static analysis 也逐仓匹配。本文不记录 G3 当前状态。
