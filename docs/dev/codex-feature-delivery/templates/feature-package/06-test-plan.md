# {{FEATURE_ID}} 测试计划

> **Purpose**：把 AC、Boundary 和风险映射为可重复验证。
>
> **Authority**：本文件定义测试设计；执行事实只在 `evidence.yaml`，Gate 决策只在 `decisions.yaml`。
>
> **适用 Profile / Target**：全部 Profile 与 Target，深度按风险裁剪。
>
> **完成时点**：G2 前；AC、Boundary、风险或验证阈值变化时修订。

本文进入 G2 `build_digest`；每个 Boundary 的实际兼容证据绑定其 `boundary_digest`，每个 Slice 的成功测试证据必须与其 code refs 一致并覆盖声明 AC。

## 1. 验证策略

- 权威输入：{{AUTHORITATIVE_INPUT_REFS}}
- 不变量与最高风险：{{INVARIANTS_AND_TOP_RISKS}}
- 环境限制及处置：{{ENVIRONMENT_LIMITS_AND_DISPOSITION}}

`passed` 必须来自完整且断言满足的 Evidence record。`not_run`、skip、截断输出、未结束进程或不等价环境不得转绿；Flaky 不得靠重跑到绿；snapshot、视觉 diff 与 AI 输出必须语义审阅。

## 2. 最小追踪矩阵

每个 Must AC、NFR、受影响 Boundary 与高风险项至少一行。按需增行，不适用专项不预建空表。

| Claim/Risk/Boundary | Test ID | 层级与场景 | Oracle/阈值 | 环境 | Evidence kind |
|---|---|---|---|---|---|
{{TEST_MATRIX_ROWS}}

层级按证明对象选择：纯规则用 unit/property；真实驱动与事务用 integration；公共语义用 contract/conformance；关键用户路径用 E2E；风险触发 security、resilience、migration、performance 或 AI eval。

公共边界按需覆盖未知字段/enum、重复乱序、旧新 producer/consumer、生成漂移、runtime 版本和 canonical fixture。涉及数据迁移、权限/租户、外部副作用、AI 行为或容量阈值时，矩阵必须列出失败路径和恢复 oracle。

## 3. Baseline 与命令

| ID | 比较/验证对象 | 权威命令来源与 CWD | 比较规则 | Evidence kind | 失效条件 |
|---|---|---|---|---|---|
{{BASELINE_AND_COMMAND_ROWS}}

Baseline 用于区分既有失败与新增回归，不能替代通过证据。代码、fixture、依赖、配置、环境、模型或 runner 改变后不得静默复用。

命令必须来自仓库脚本、构建定义或 CI。真实 command、工具版本、CWD、SHA、时间、退出码、结果和日志只追加到 `evidence.yaml`，不回填本文。

## 4. 数据与专项说明

- Fixture/dataset、分类、脱敏与清理：{{TEST_DATA_RULES}}
- 条件专项及不适用依据：{{CONDITIONAL_TEST_NOTES}}

AI 变化需固定 dataset/holdout、模型与 prompt/tool schema、runner、seed/temperature、质量/安全/成本阈值；少量主观对话不能替代 Eval。真实生产数据必须已有授权、最小化、脱敏、审计和清理规则。

`controlled` 至少增加 static analysis 和 security review 证据设计；受限数据增加 data review。这些证据必须有持久 artifact、digest 和覆盖决策有效窗口的保留期。

## 5. G2 可评估条件

- 所有必须声明均能追踪到 Test ID、oracle、环境和允许的 Evidence kind；
- 风险越高，验证越接近真实依赖，且失败与不可执行处置明确；
- baseline 比较算法、命令权威来源和证据失效条件明确；
- 缺口有 Risk/Exception ID 及有效 Decision ID。

本文件不能自证 Gate；evaluator 结合 policy、manifest 和 ledgers 计算资格。
