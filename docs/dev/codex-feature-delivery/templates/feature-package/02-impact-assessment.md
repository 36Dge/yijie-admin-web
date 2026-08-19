# {{FEATURE_ID}} — 影响评估

| 元数据 | 值 |
|---|---|
| Purpose | 用证据确定仓库、依赖、Boundary、数据与风险影响 |
| Authority | 本文权威描述分析结论；当前基线、Profile、Target 与 Gate 以 `feature.yaml` 为准 |
| 适用范围 | 全部 Profile / Target |
| 完成时点 | G1 决策前；baseline/依赖动态事实最迟在 G2 前闭合，相关分析也供后续逐 Boundary G2C 使用 |

> 调查命令、结果与观测 SHA 只进 `evidence.yaml`；本文引用 Evidence ID，不复制快照。

本文进入 G1 `scope_digest`；当前 baseline/依赖解决状态还进入 G2 `build_digest`，因此不得用一个不随当前事实变化的稳定声明绕过 G2 重新授权。

## 1. 调查与影响

{{DISCOVERY_AND_IMPACT}}

按需记录：

- `SCAN-* | 仓库/组件 ref | 已读规则 | 调查问题 | Evidence ID`；
- `FND-* | fact/inference | 结论 | Evidence ID/推断输入`；
- `IMP-* | 仓库/组件 | direct/indirect/none | 原因或排除证据 | owner ref`。

对相邻但无影响的仓库也要说明排除依据；推断不得写成观测事实。

## 2. Boundary

{{BOUNDARIES}}

每个跨进程、跨仓库、跨版本、持久化、重放或第三方边界使用独立 `BND-*`，记录
`type | impact | authority ref | producer | 已知且受支持 consumers | 发现 Evidence ID`。
类型仅为 `generated_schema`、`handwritten_protocol`、`database_format`、
`runtime_third_party`、`semantic_only`；已声明 Boundary 的 impact 仅为
`additive`、`semantic`、`breaking`；没有 Boundary 时保持 `boundaries: []`。

公开边界只承诺已知且受支持 consumer，不把“未发现”外推为“全部兼容”。
G2 先授权实现范围；之后每个已声明 Boundary 分别通过 G2C，且只解锁依赖该 Boundary 的 Slice。
每个已声明 Boundary 必须指向唯一 `boundary_spec` artifact；`04-contract-change-plan.md` 仅作导航索引。

## 3. 数据、安全与依赖

{{DATA_RISK_DEPENDENCIES}}

只记录改变方案或 Profile 的迁移、reader/writer 共存、认证/租户/隐私、供应链、第三方版本、
付费或不可逆副作用。每项须有 `DEP/RSK/BND-*` 与 Evidence ID；高风险强制 `controlled`。

## 4. 依赖 DAG 与 Size

{{DAG_AND_SIZE}}

用 `DAG-* | 交付物 | requires | blocks | owner | 完成判据` 表达真实依赖，不预设合并/迁移/部署顺序。
G2 前必须完成 Feature Size、Profile 与拆分复核，并引用对应 Decision ID。

## 5. Spike

{{SPIKES_OR_NA}}

只保留阻塞性未知项，格式为
`SPK-* | 未知项 | 安全验证 | 禁止副作用 | owner | due_at | open/resolved/blocked | Evidence/Decision ID`。
