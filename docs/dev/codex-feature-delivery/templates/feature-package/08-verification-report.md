# {{FEATURE_ID}} 验证索引

> **Purpose**：把 Claim、Slice、Boundary、Finding 与不可变 Evidence ID 连接起来。
>
> **Authority**：本文只做索引，不复制执行事实或声明 Gate；原始事实与决策分别在 `evidence.yaml`、`decisions.yaml`。
>
> **适用 Profile / Target**：全部 Profile 与 Target。
>
> **完成时点**：G4 前；代码或验证主体变化时追加新 Evidence 并更新引用。

G3 按实例绑定 `slice_digest` 和逐仓 `sha + base_sha`，`controlled` 的 `static_analysis` 精确匹配该 G3 代码主体；G4 绑定全 repository code/base refs 与 `engineering_digest`，每仓最终测试、review、`controlled` 的 `security_review` 与适用 `data_review` 精确匹配 G4 主体。不同 Gate 或不同基线的证据不能拼接。

## 1. Coverage

| Claim/Slice/Boundary | Test/实现引用 | Evidence IDs | Review Evidence ID | 失效条件 |
|---|---|---|---|---|
{{COVERAGE_ROWS}}

Coverage 表示有效证据覆盖声明，不是“有一行”。计划、截图说明、口头结论、`not_run`、skip、截断输出、未结束任务、过期或主体不匹配的 Evidence 都不计入。
被决策引用的成功 Evidence 还必须满足时间有序且非未来，至少声明一个带 immutable URI、digest 和覆盖决策有效窗口的 artifact。Evaluator 校验这些元数据及绑定关系；URI 可访问性与 artifact bytes/digest 的真实一致性由受保护 CI/审批面验证并出具可信 receipt。

## 2. Baseline 与 Review

- Baseline/comparison Evidence 及差异解释：{{BASELINE_COMPARISON_REFS}}
- Review Evidence、Finding 与复验引用：{{REVIEW_AND_FINDING_REFS}}

Review record 必须绑定 repository、精确 base/head、diff 范围和 reviewer。任一主体变化后需要新 Evidence ID。

Finding 保存稳定描述，不维护第二份 Open/Closed：P0/P1 必须有修复与复验证据；例外必须有 Decision ID、范围、Owner、期限和失效条件。单人开发可由同一人承担多角色，但不得伪造独立 reviewer。

## 3. 专项与异常

- Contract、安全/租户、migration/resilience、performance、AI Eval、visual/accessibility 的适用证据或不适用依据：{{SPECIAL_COVERAGE_REFS}}
- 未验证项、异常、残余风险及处置 Decision ID：{{GAPS_AND_EXCEPTIONS}}

一个 Gate instance 的证据不会因名称相似自动满足另一个实例。共享证据必须在 subject 中显式覆盖每个对象。没有有效 Evidence ID 的声明默认未证明。

## 4. G4 复核问题

- 每个 Must AC、NFR、Slice、Boundary 和高风险项由哪些 Evidence ID 证明？
- 命令证据是否含完整上下文且不是 ledger 值 `not_run`？
- 哪些 baseline/review 因代码、依赖、生成物或环境变化而失效？
- 每个 Finding 如何被修复、复验或通过有期限例外处理？
- 哪些事实仍未验证，是否阻断对应 Gate？

本文不写“Code Complete”或批准结论；evaluator 计算资格，Gate Owner 只在 `decisions.yaml` 追加决定。
