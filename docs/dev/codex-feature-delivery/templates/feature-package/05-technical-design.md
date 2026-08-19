# {{FEATURE_ID}} — 技术设计

| 元数据 | 值 |
|---|---|
| Purpose | 定义可实现、可验证、可撤回的方案及安全不变量 |
| Authority | 本文权威描述技术方案；当前 Profile、Target、Gate 与 revision 以 `feature.yaml` 为准 |
| 适用范围 | `standard`、`controlled` / 全部 Target；`lite` 在 Feature Brief 写最小设计 |
| 完成时点 | G2 决策前；Boundary 专项在对应 G2C 前完整 |

> 运行结果与批准分别只写入 `evidence.yaml`、`decisions.yaml`；本文不复制状态或 SHA。

本文进入 G2 `build_digest`。Boundary 专项不混写在本文：`04-contract-change-plan.md` 是索引，每个 `boundaries/<BND-ID>.md` 独立进入其 `boundary_digest`。

## 1. 方案与组件

{{SOLUTION_AND_COMPONENTS}}

用最短文字说明选择、权衡、不负责内容，并按需增加
`CMP-* | 仓库/组件 | 职责 | 输入/输出 Boundary | owner`。依赖只能指向能力/数据权威方，禁止复制第二权威源。

## 2. 依赖 DAG

{{DEPENDENCY_DAG}}

每步使用 `DAG-* | code/contract/data/deploy/enable/cleanup | 动作 | requires | 完成判据 | 失败动作`。
合并、迁移、部署、启用和清理由 DAG 决定，不固定 `deploy → migrate`，每个节点须可独立验证和撤回/前滚。

## 3. 时序、状态与不变量

{{SEQUENCES_STATES_INVARIANTS}}

只展开会改变验收或安全性的路径；状态行使用
`ST-* | state | event/guard | next | side effect | 非法/重复处理`，不变量使用
`INV-* | domain/auth/tenant/data/effect | 规则 | 服务端强制点 | 失败行为 | Test ID`。
客户端隐藏、提示词或调用方自律不能替代服务端认证/授权、租户隔离、输入、secret、日志和审计控制。

## 4. 数据迁移（适用时）

{{MIGRATION_OR_NA}}

涉及持久化时按 `expand → backfill → switch → contract` 说明旧/新 reader/writer、验证和撤回/前滚，
并映射到 DAG；不得在一个不可回退节点中删旧格式、全量迁移并强制所有调用方切换。

## 5. 韧性、可观测性与预算

{{RESILIENCE_OBSERVABILITY_BUDGETS}}

只记录会阻断 Gate 的事务/并发/幂等、超时/重试、限流/降级/补偿、资源释放、信号与性能/成本上限；
每项使用 `RES/OBS/BUD-* | 设计或指标 | 上限/停止条件 | Test/Baseline Evidence ID`。

## 6. 配置、AI 与方案决策

{{CONFIG_AI_AND_DECISIONS}}

按需说明 Flag 默认/关闭行为与共存窗口；AI 功能补充固定 prompt/model/retrieval/tool ref、拒答/降级、
注入/工具授权和 Eval ID。最后只引用技术、安全/数据及 ADR Decision ID，不在本文表示批准已发生。

`controlled` 还必须明确安全/数据 review 边界、walking skeleton、故障注入/恢复和不可逆节点的额外控制。
