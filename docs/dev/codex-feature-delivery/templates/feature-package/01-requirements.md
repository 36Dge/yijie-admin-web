# {{FEATURE_ID}} — 需求与验收标准

| 元数据 | 值 |
|---|---|
| Purpose | 把业务意图转换为可测试的行为契约 |
| Authority | 本文权威描述业务规则与验收语义；当前声明以 `feature.yaml` 为准 |
| 适用范围 | 全部 Profile / Target |
| 完成时点 | G1 决策前 |

> 已执行验证与批准分别只写入 `evidence.yaml`、`decisions.yaml`；本文仅引用 ID。

G1 decision 绑定包含本文的 `scope_digest`。本文变化会使 G1 及依赖决策失效，但未到阶段的实施/发布占位不影响 G1。

## 1. 角色与规则

{{ACTORS_AND_RULES}}

按需增加 `ACT-* | 角色 | 权限/租户边界 | 场景` 与 `BR-* | 可观察规则 | 优先级 | 来源 ID`。

## 2. 行为语义

{{BEHAVIOR_SEMANTICS}}

只展开适用场景，但必须判定正常、非法输入、权限/跨租户、失败、取消/超时、重试、
重复/乱序/并发、部分成功以及旧版本/未知值；不适用项给出理由 ID。

## 3. 验收标准

{{ACCEPTANCE_CRITERIA}}

每行使用 `AC-* | Given | When | Then | 不可接受行为 | Rule/Slice ID`，不得用实现步骤替代用户可观察结果。

## 4. 数据、非功能与副作用

{{DATA_NFR_EFFECTS}}

按需增加：

- `DATA-*`：来源、分类、租户边界、保留/删除和日志限制；
- `NFR-*`：可测要求、阻断阈值与 Test ID；
- `EFF-*`：外部写入、可逆性、用户意图/授权、幂等/补偿与审计。

真实 secret、身份或经营数据不得进入文档、fixture 和日志；未覆盖的高风险写操作默认拒绝。

## 5. 非目标与未决项

{{NON_GOALS_AND_OPEN_ITEMS}}

未决项格式为 `Q-REQ-* | 问题 | 影响 | owner | due_at | open/resolved/blocked | Evidence/Decision ID`。
阻塞权限、数据分类或验收的事项必须在 G1 前关闭；需求确认由 G1 Decision 记录。
