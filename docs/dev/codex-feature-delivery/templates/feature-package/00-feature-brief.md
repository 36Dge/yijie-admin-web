# {{FEATURE_ID}} — {{TITLE}}

| 元数据 | 值 |
|---|---|
| Purpose | 定义问题、范围、成功标准与合适的交付规模 |
| Authority | 本文仅权威描述稳定业务意图；当前 Profile、Target、Owner、Gate 与基线以 `feature.yaml` 为准 |
| 适用范围 | 全部 Profile / Target |
| 完成时点 | G0 决策前完整；Scope 变化时更新 |

> 执行事实只进 `evidence.yaml`，批准只进 `decisions.yaml`；本文只引用 ID，不复制当前状态或 SHA。

G0 decision 绑定 evaluator 对当前声明与本文计算的 `intake_digest`。后续设计、验证或发布文档尚未完成不阻塞 G0。

## 1. 目标与用户价值

{{OUTCOME}}

用最短文字回答：谁遇到什么问题、交付后能观察到什么变化、为什么现在做。

## 2. 范围

{{SCOPE}}

按需列 `SCP-* | in/out | 内容 | AC 引用/排除原因`。范围变化必须产生新决策并重评后续 Gate。

## 3. 成功标准与约束

{{SUCCESS_AND_CONSTRAINTS}}

每个成功标准使用 `MET-*`，给出可重复测量的目标、窗口、数据源与基线 Evidence ID；
每个不可违反的兼容、安全、隐私或成本约束使用 `CON-*` 并注明来源 ID。

## 4. 未知项

{{OPEN_ITEMS}}

仅记录会改变目标、范围、验收或 Profile 的事项，格式为
`Q/ASM-* | 内容 | 验证方式 | owner | due_at | open/resolved/blocked | Evidence/Decision ID`。
阻塞项未关闭时不得通过 G1。

## 5. Feature Size 与 Profile

{{SIZE_AND_PROFILE}}

结论必须引用仓库/Boundary/Slice 数、依赖与迁移复杂度以及数据、安全、兼容和外部副作用风险。
受限数据、Breaking、复杂迁移、高权限或不可逆副作用强制 `controlled`；过大的需求先拆成可独立 G3 的 Slice。

## 6. `lite` 最小设计

{{LITE_DESIGN_OR_NA}}

`lite` 在此说明组件入口、依赖方向、安全/数据不变量、失败/幂等和安全撤回；
`standard` / `controlled` 写 `N/A — 使用 05-technical-design.md`。
