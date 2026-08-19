# Definition of Ready：G0—G2 输入清单

这份清单只用于发现缺口，不批准 Gate。勾选完成后仍需 evaluator 判定 `ELIGIBLE`，再由有权人在 `decisions.yaml` 对精确 subject 作决定。`not_applicable` 只能由 policy 派生，不追加 N/A decision；`not_run` 永不算完成。

## Intake / G0

- [ ] Feature ID、标题、Owner、目标、非目标和成功指标明确
- [ ] `schema_version: 2`，显式选择 `lite|standard|controlled`
- [ ] 显式选择 `local_engineering|staging|production`，未把 Target 当风险等级
- [ ] 初始数据分类、真实账户、外部写、费用和不可逆风险已声明
- [ ] 只读调查的允许范围、禁止动作和未知项明确
- [ ] artifact manifest 与当前 Profile/Target/风险路由一致
- [ ] G0 decision 绑定当前 `intake_digest`，而非“最新版”

## 需求与范围 / G1

- [ ] Must 需求有编号化、可判定 AC/NFR
- [ ] 成功、失败、空数据、边界、权限、超时、取消、重复和部分成功有预期
- [ ] 阻塞 Open Questions 已由有权人关闭，未让 Codex 默认补规则
- [ ] 逐仓读取适用项目指令（例如 `AGENTS.md`）、安全、架构、ADR 和 CI 文档
- [ ] 记录 remote、branch、完整 HEAD、工具链、Git 状态和用户已有改动
- [ ] 入口、调用链、存储、测试、生成器和发布控制面来自真实代码/CI
- [ ] producer、consumer、数据、权限、外部系统和 AI tool boundary 逐项登记
- [ ] 每个 boundary 有 Owner、权威源、方向和影响分类，无影子权威源
- [ ] 完成 Feature size、未知量、依赖、关键路径和回滚难度评估
- [ ] 过大范围已拆 Epic/独立 Feature，每个子 Feature 可独立验收
- [ ] Profile 与风险信号一致；Target 终点与真实交付意图一致
- [ ] G1 decision 绑定 requirements/impact/size/boundary 清单的 `scope_digest`

## Baseline 与设计 / G2

- [ ] 每个受影响仓库的 baseline 已真实执行并追加到 `evidence.yaml`
- [ ] baseline 包含 cwd、完整 SHA、工具版本、时间、exit code 和日志引用
- [ ] 既有失败与本需求失败分离，并有 Owner/风险/处置
- [ ] 架构、安全、数据、第三方、AI、成本和 migration 的阻塞决策已关闭
- [ ] 技术设计覆盖状态、失败、并发、幂等、权限、数据、观测与恢复
- [ ] 每条 AC/风险映射到测试层、fixture/dataset、环境、阈值和 evidence kind
- [ ] contract/conformance、integration、E2E、security、migration、AI Eval 已按风险判定
- [ ] 实现拆为可独立验证、可回滚的 slice，并声明依赖 DAG
- [ ] 每个 slice 有允许/禁止范围、关联 AC/boundary、验证和停止条件
- [ ] G2 Packet 以 canonical repo identity、逐仓 base SHA 与 `{repository,path}` 精确覆盖 Slice scope；capability 来自 policy 闭集且禁止集完整
- [ ] `.` 整仓 scope 有 justification；`controlled`/高风险另有逐仓成功 exception Evidence
- [ ] `controlled` 或跨仓 Feature 已将 walking skeleton 排在早期
- [ ] `controlled` 使用更短授权期并要求 static analysis/security review；受限数据已安排 data review
- [ ] 外部写、真实数据、付费、部署、migration、不可逆动作标为需新授权
- [ ] G2 decision 绑定设计/测试/slice/当前 baseline/依赖状态的 `build_digest`

## Boundary / G2C 准备

对每个受影响 boundary 单独检查，不使用一个总勾选替代：

- [ ] `04-contract-change-plan.md` 只是索引，manifest 中该 Boundary 指向唯一 `boundaries/<BND-ID>.md`
- [ ] 权威源、producer、全部已知 consumer 和数据方向明确
- [ ] 支持基线、版本/digest、generator 和不可变 pin 明确
- [ ] 结构兼容与人工语义兼容均按影响覆盖
- [ ] 演进/发布 DAG 的安全不变量和恢复路径明确
- [ ] G2C 将使用 boundary ID 作为 instance 并绑定该实例的 `boundary_digest`/evidence

## Ready 结论

- [ ] evaluator 对 G0、G1、G2 的当前输入均非 `BLOCKED`
- [ ] 所有 `passed` decision 的 actor 为可追溯人类，roles 是 manifest 已分配角色的子集，并由包外 trust root 中 scope 匹配的 Ed25519 key 验签；没有伪造独立人审
- [ ] Codex/Agent Review 仅作为 evidence，没有被当作 APPROVED
- [ ] 当前 subject、证据、依赖和策略自决策后未变化；否则已标 `stale`

缺一项时继续调查、设计或隔离 spike；不得开始未获授权的业务实现。

未到阶段的 Markdown 占位不会阻塞 G0/G1，但不能为通过当前 Gate 而留下该阶段占位。`--strict` 与 `lifecycle: completed` 要求全部适用 Gate 和文档闭环。
