# Definition of Done：G3 与 G4 输入清单

这份清单不产生 Gate 决策。每个 slice 分别完成 G3；全部实例有效并完成集成证明后，才可评估 G4 Engineering Complete。

## 每个 Slice / G3

- [ ] 使用精确 slice ID 和仍有效的 authorization packet
- [ ] G2 packet 以 `{repository,path}` 精确覆盖该 Slice，逐仓 base SHA 正确，canonical capability 与策略允许/禁止集一致
- [ ] 前置 G2 与适用 G2C 仍为有效 `passed`
- [ ] `slice.depends_on` 中每个前置 Slice 的 G3 仍有效
- [ ] subject、依赖、环境、数据和风险未漂移；漂移时已停止并重新授权
- [ ] 只修改批准范围，无未知文件、用户改动被覆盖或无关重构
- [ ] 生成物来自正确权威源和锁定 generator，未手改
- [ ] 正常、边界、非法输入和适用失败路径有真实验证
- [ ] lint/test/build/generate/Eval 等结果已追加到 `evidence.yaml`
- [ ] evidence 包含 cwd、完整 SHA、工具版本、有序且非未来的时间、exit code、结果和日志/artifact
- [ ] 被决策引用的成功 evidence 有 immutable URI、digest、未过期保留期，且受保护 CI/审批面已核验 artifact bytes 可访问并与 digest 一致
- [ ] `not_run` 保持未执行，写明风险和补验证条件，未显示为绿色
- [ ] 完整 diff、Git 状态、依赖、migration、安全和日志已审查
- [ ] 新外部写、真实数据、付费、部署、migration 或不可逆需求已停止并申请新授权
- [ ] Review finding 已记录；Codex Review 仅作为 evidence
- [ ] G3 decision 绑定当前 `slice_digest` 与逐仓 `sha + base_sha`；测试及 controlled static analysis 精确匹配并覆盖 AC

## 需求与集成 / G4

- [ ] 全部适用 G2C 与 G3 实例有效，无 `blocked|failed|stale|pending`
- [ ] 每条 Must AC/NFR 映射到最终实现和可重复 evidence
- [ ] 最终代码与批准的需求、契约和设计一致；范围变化已重走失效链
- [ ] 无目标路径 mock、placeholder、调试后门、硬编码 fixture 或阻塞 TODO
- [ ] 正常、失败、权限、租户、事务、并发、幂等、超时、取消、重试和部分成功按风险覆盖
- [ ] unit、integration、contract/conformance、适用 E2E/Eval 有真实结果
- [ ] breaking check 与人工语义兼容均完成；下游使用不可变引用
- [ ] migration 的新旧 reader/writer、回填、校验、暂停恢复已验证
- [ ] Secret/token/PII 未进入代码、fixture、日志、文档或制品
- [ ] 新依赖的必要性、版本、漏洞、许可证和供应链风险已检查
- [ ] 日志、指标、trace、告警、审计和 kill switch 足够验证与恢复
- [ ] 完整 diff、生成物、lockfile、migration、制品来源和工作区已复核
- [ ] P0/P1 清零；其他 finding 有 Owner、期限和接受 decision
- [ ] `08-verification-report.md` 引用账本 evidence，未复制/改写执行事实
- [ ] G4 decision 绑定全部实例、逐仓 code/base refs 与 `engineering_digest`；review/security/适用 data review 逐仓精确匹配

## Done 结论

- [ ] evaluator 对 G4 输入为 `ELIGIBLE`，且存在有效有权 decision
- [ ] actor 为可追溯人类，roles 是 manifest 已分配角色的子集，完整 Decision 已由受保护 trust root 的 scope 匹配 key 验签；单人多角色未伪装成独立人审
- [ ] 自决策后 subject、依赖、证据和策略未变化；否则已标 `stale`

`local_engineering` 在 G4 结束并明确“未发布”。只在 G4 有效通过后才 materialize `10-delivery-summary.md`；Summary 不属于 G4 输入。`staging`/`production` 继续使用 Production Readiness；G4 不等于 G5 或 G6。
