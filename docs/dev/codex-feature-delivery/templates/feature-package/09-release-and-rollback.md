# {{FEATURE_ID}} 发布与恢复 Runbook

> **Purpose**：为精确制品—环境主体定义发布 DAG、安全不变量、停止与恢复。
>
> **Authority**：本文是计划；G5 主体/批准在 `decisions.yaml`，且 `passed` 必须由包外 trust root 验签；执行 journal 在 `evidence.yaml`。
>
> **适用 Profile / Target**：仅 `staging`、`production`；`local_engineering` 不生成。
>
> **完成时点**：G4 后、G5 前；主体或 DAG 改变时重新批准。

## 1. Release Subject 与不变量

- G5 Subject：{{RELEASE_SUBJECT_REQUIREMENTS}}
- 安全不变量、检测信号与违反动作：{{SAFETY_INVARIANTS}}

Subject 必须绑定 `release_digest`、当前 G4 `engineering_decision_ref`、每个 repository 的 `sha + base_sha`、artifact digest/provenance、contract/generator pin、与 Target 相等的精确 environment/account/config/data state、rollback 或 roll-forward 主体、授权动作与窗口。每仓 `release_artifact` Evidence 必须把同一 code/base 连到同一制品；标签、分支、`latest` 或“当前版本”不够精确，任一字段变化使旧 G5 决策失效。

不变量至少覆盖适用的身份/租户、不可逆数据、consumer 兼容、队列/缓存、secret/config、审计、Flag 安全默认值和资源上限。

## 2. 发布 DAG

```text
{{RELEASE_DAG}}
```

| Step | 主体/动作 | 依赖与角色 | 成功/停止判据 | Undo 或 roll-forward |
|---|---|---|---|---|
{{RELEASE_STEP_ROWS}}

合并、构建、配置、schema expand、backfill、consumer 更新、部署、流量切换、Flag 激活和 schema contract 是独立节点，按真实依赖排序；禁止固定套用 `deploy → migrate`。节点成功不自动授权下一节点。

## 3. 操作与数据恢复

- 权威命令/控制面、最小角色、secret 引用和 dry-run：{{OPERATIONS_AND_ACCESS}}
- Reader/Writer 组合、批次/锁/限流、不可逆点与恢复：{{DATA_RECOVERY_PLAN}}

命令必须来自真实平台或仓库 Runbook。本文不存 secret；Codex 不得推测生产命令、权限或环境标识。无法安全回滚时必须预先定义 roll-forward、修复和批准，不能假设回退制品即可恢复数据或外部副作用。

## 4. 灰度、Smoke 与阈值

| Stage/Signal | Scope 与进入条件 | 最小窗口/样本 | Continue | Stop/Rollback |
|---|---|---|---|---|
{{ROLLOUT_AND_SIGNAL_ROWS}}

- Flag/流量控制、kill switch 与传播校验：{{TRAFFIC_CONTROLS}}
- Smoke 用户路径、身份/租户、断言与副作用清理：{{SMOKE_PLAN}}

阈值必须有分母、窗口、查询和数据延迟；至少覆盖适用的业务成功、错误/延迟、资源/队列、数据、安全/审计及 AI 质量/成本。没有报警不等于满足扩量条件。

## 5. 停止与演练

```text
阈值或不变量违反
  → 冻结扩量和不可逆动作
  → 隔离流量并检查数据/事件/缓存/队列/外部副作用
  → 执行制品回退、数据恢复、补偿或 roll-forward
  → 复验不变量、Smoke 与观察窗口
  → 新 Decision 决定继续或终止
```

- 触发器、恢复节点与升级路径：{{RECOVERY_TRIGGERS}}
- 演练环境、故障注入与成功 oracle：{{DRILL_PLAN}}

演练被跳过、环境不等价或恢复未完成时只能在 ledger 记录 canonical 值 `not_run`/`failed`，并在 `notes` 写明原因和补验证条件。

## 6. Execution Journal

每个 DAG 节点追加 Evidence record，绑定 Release Subject/Step ID、operator/授权、精确 action/environment、时间/工具/结果、前后制品/config/data、观察窗口与样本，以及失败/暂停/补偿关联 ID。Markdown 不维护第二份执行状态。

G6 只消费 ledger 中与当前 G5 具有相同 `release_digest`、code refs、`engineering_decision_ref`、artifact/environment/account refs 的 release execution、smoke、observation 与 outcome evidence；Runbook 自身不能证明发布已发生。Delivery Summary 仅在 G6 有效通过后生成，不是 G6 输入。
