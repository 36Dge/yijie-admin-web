# {{FEATURE_ID}} — 决策与风险

| 元数据 | 值 |
|---|---|
| Purpose | 保存决策上下文、风险控制和升级条件 |
| Authority | 本文权威描述分析；最终选择、批准和 Gate 以 `decisions.yaml` / `feature.yaml` 为准 |
| 适用范围 | `standard` / `controlled` 必需；`lite` 不创建 / 全部 Target |
| 完成时点 | G2 决策前；出现新风险时在继续相关工作前更新 |

> 证据只进 `evidence.yaml`，Decision 只追加到 `decisions.yaml`。`passed` 必须由包外 trust root 中 scope 匹配的 key 验签；同一人兼任角色时按真实角色记录，不伪装独立复核。

## 1. 决策上下文

{{DECISION_CONTEXT}}

按需增加 `TOP-* | 问题/约束 | 选项及权衡 | 建议 | Decision ID`；改变职责、依赖、公共契约、
安全边界或既有 ADR 时必须引用 ADR。

## 2. 风险与威胁

{{RISKS_AND_THREATS}}

风险格式为 `RSK-* | 事件/触发 | likelihood | impact | 预防 | 检测 | 恢复 | owner | status | Evidence/Decision ID`；
威胁格式为 `THR-* | 资产/Trust Boundary | 路径 | 服务端控制 | Security Test ID | Residual Risk ID`。
至少判定认证/授权、跨租户、注入/SSRF/路径、提示注入/工具越权、敏感日志和供应链。

高影响兼容、受限数据、复杂迁移、高权限或不可逆副作用强制 `controlled`；接受残余风险必须有范围和期限。

## 3. 数据与高风险操作

{{DATA_AND_HIGH_RISK_OPERATIONS}}

说明数据收集到删除/导出的生命周期；高风险操作使用
`OP-* | 用户意图 | 影响上限 | deny/dry-run/bounded-allow | 所需角色 | 审计字段`。
项目 Gate 不替代 Codex 产品层面的 sandbox、用户批准或权限授权。
有效操作权限是 Codex sandbox/approval policy、当前路径适用的 `AGENTS.md` 与 Feature Authorization Packet 的交集，任一层缺失或禁止都必须停止。

## 4. 例外与停止条件

{{EXCEPTIONS_AND_STOP_CONDITIONS}}

例外格式为 `EXC-* | 范围/原因 | 补偿控制 | owner | expires_at | status | Decision ID`。
遇到需求冲突、破坏性 Boundary/迁移、真实 secret/敏感数据、未授权副作用、范围扩大、
新生产依赖、无法归因的基线失败、未知工作区变更或权限不明时，必须 stop/isolate/revert/escalate。
