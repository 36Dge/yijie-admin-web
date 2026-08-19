# Release & Outcome Readiness：G5 与 G6 输入清单

本清单适用于 Target=`staging|production`。`local_engineering` 到 G4，G5/G6 由 target policy 派生 `not_applicable`，不追加 N/A decision；绝不能据此宣称已发布。清单不批准 Gate。

## 精确发布候选 / G5

- [ ] G4 对当前集成候选仍为有效 `passed`
- [ ] 每个制品有 version/tag、完整 commit、digest、来源和构建 evidence
- [ ] 制品来自干净、不可变、可复现的 source，无 dirty 或未登记的浮动 checkout
- [ ] Contract、Runtime、模型、Skill、Knowledge、配置和 migration 组合已固定
- [ ] SBOM/provenance、依赖、许可证和供应链要求按风险完成
- [ ] 目标环境的 secret、权限、容量、账户和外部依赖有真实确认
- [ ] G5 decision 绑定 `release_digest`、精确 Target 环境、制品集合和发布计划，不写“最新版本”
- [ ] artifact refs 由引用的制品 evidence 覆盖，rollback ref 指向同 subject/环境的成功演练 evidence

## 发布 DAG 与数据安全

- [ ] 合并、publish、deploy、migration、backfill、enable、observe、cleanup 建成依赖 DAG
- [ ] 顺序由兼容与数据安全不变量推导，不固定为 `deploy → migrate`
- [ ] 每节点写明输入/输出、前置、执行授权、验证、停止条件和补偿/roll-forward
- [ ] 新 request 只在 receiver 已接受后产生，新 response/event 只在 consumer 已容忍后产生
- [ ] 新旧应用、数据和契约组合有实际兼容证据
- [ ] Migration/回填可暂停、恢复、重试、校验，资源/锁影响明确
- [ ] 不可逆点前有备份/PITR、审批、演练和明确恢复策略
- [ ] Feature Flag 默认处于批准的安全状态并有 kill switch

## 灰度与观测

- [ ] 每个阶段的对象、百分比、观察窗口和决策人明确
- [ ] 业务成功率、错误率、延迟、资源、成本和安全指标有阈值
- [ ] 适用 AI 功能有锁定 dataset/Eval、质量退化与成本/延迟阈值
- [ ] Dashboard、告警、日志、trace 和审计在启用前可用
- [ ] Smoke 验证关键用户结果，且不会产生未经授权的高风险副作用
- [ ] 停止扩量、流量隔离、上一制品、rollback/roll-forward 路径可执行
- [ ] 发布/回滚 Owner 与升级路径可用

## 外部动作授权

- [ ] 部署、流量/flag、migration、真实数据、外部写和付费调用分别有精确新授权
- [ ] 授权含目标环境/账户、范围、预算、有效期、停止和恢复
- [ ] 未把 G5、旧授权或“正常发布步骤”解释为无限操作权
- [ ] 每个实际动作将追加 evidence，不预填执行成功

## G5 结论

- [ ] evaluator 对当前 G5 subject 为 `ELIGIBLE`
- [ ] 有权人类 actor 基于引用 evidence 作有效 decision，roles 是 manifest 已分配角色的子集，完整 Decision 已由受保护 trust root 的 scope 匹配 key 验签
- [ ] 所有 `not_run`/残余风险由有权人明确接受，未显示绿色
- [ ] subject、环境、制品、依赖和计划未变化；否则已标 `stale`

## 目标环境结果 / G6

- [ ] 实际执行节点、版本、时间、环境、exit code 和日志已追加到账本
- [ ] 时间序合理且不在未来；关键 artifact 有 immutable URI、digest、未过期保留期，并由受保护 CI/审批面核验可访问性与 bytes/digest 一致性
- [ ] 发布命令成功之外，目标环境 readiness 与关键 smoke 有独立 evidence
- [ ] 业务结果、错误、延迟、资源、成本和安全指标完成观察窗口
- [ ] 权限、租户、审批、审计和脱敏完成抽查
- [ ] Incident、回滚、数据异常、部分失败和补偿已记录并处置
- [ ] G6 的 `release_digest`、artifact refs 和 environment 与当前有效 G5 完全一致
- [ ] G5 authorization account、G5 `account_ref` 与 release/rollback evidence 的 account 一致
- [ ] 每条 G6 Evidence 的 environment、account、artifact refs 与当前 G5 完全一致，并且执行开始晚于 G5 decision
- [ ] 时间链满足 `release_execution.finished_at ≤ smoke.started_at`、`smoke.finished_at ≤ observation/owner_acceptance|outcome_metric.started_at`
- [ ] `release_execution`、`smoke`、`observation` 和实际采用的 `owner_acceptance|outcome_metric` 各自覆盖全部 AC
- [ ] 实际版本/范围与 `feature.yaml` 和制品一致
- [ ] Runbook、release notes、用户/运维文档已更新
- [ ] 旧契约/列、双轨、临时 Flag 和例外有清理 Issue、Owner 和期限
- [ ] G6 decision 绑定目标环境实际 subject 与观察 evidence
- [ ] 自决策后实际版本或关键结果未变化；否则已标 `stale`

只有 G6 有效通过后，`staging|production` Feature 才能按对应 Target 声称 Outcome Verified。然后才 materialize `10-delivery-summary.md`，以当前 G6 `release_digest` 作为 `terminal_subject_digest`，再进行 `--strict`/`completed` 闭环。Summary 不是 G6 的输入或证明。
