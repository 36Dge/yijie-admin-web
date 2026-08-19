# Codex 实战操作规程 v2

本规程消费项目接入后的真实配置。`<PROJECT_ROOT>`、`<FRAMEWORK_ROOT>`、Feature root、repository identity、角色和 CI 均以 [.feature-delivery 配置说明](PROJECT_ADOPTION.md) 为准，不从目录名或聊天历史推断。

## 1. 每次任务的上下文包

不要把聊天历史当唯一权威。每次交给 Codex 的任务至少引用：

- Feature ID、`schema_version: 2`、Profile、Target；
- 当前 Gate 与 instance（boundary ID 或 slice ID）；
- subject 的精确版本和适用 decision/evidence ID；
- 当前 authorization packet、有效期与失效条件；
- 目标、非目标、AC/NFR 和允许/禁止范围；
- repository、branch/完整 SHA、用户已有改动；
- 适用 `AGENTS.md`、架构、安全与契约权威源；
- 数据分类、环境、账户、费用与外部副作用约束；
- 验证命令、判定阈值、所需 evidence 和停止条件。

Codex 开始前先复核这些事实。任一精确版本不匹配、规则冲突、授权过期或范围变化，立即停止受影响操作并报告，不沿用旧批准。

`subject` 必须使用当前 Gate 的分段 digest：G0/G1/G2 为 intake/scope/build，G2C/G3 为当前 boundary/slice 实例，G4/G5/G6 为 engineering/release。不得用“当前最新包”或一个全局 digest 替代实例绑定。

### 产品权限与项目授权不是一回事

Codex 的 sandbox/approval policy 决定工具在技术上能否执行，`AGENTS.md` 决定当前路径必须遵守的仓库指令，Feature Authorization Packet 决定本次业务动作是否获准。有效权限是三者交集；任一层拒绝或缺失都必须停止。产品侧允许写工作区不等于 G2/G5 已批准，项目 Gate 通过也不能绕过 sandbox、网络或外部副作用审批。

## 2. 标准任务模板

### 2.1 只读调查

```text
为 <Feature ID> 做只读调查，不修改文件，不访问真实敏感数据，不触发外部写或付费调用。

读取当前路径适用的 AGENTS.md 和仓库文档，检查 Git 状态；找到入口、调用链、
测试、契约权威源、生成器、数据、权限、consumer、CI 和发布控制面。

输出：
1. Fact / Assumption / Unknown；
2. 每仓完整 HEAD、已有改动、baseline 命令与可重复结果；
3. boundary 清单和 contract impact；
4. size、依赖、关键路径、Epic 拆分建议；
5. 安全、migration、AI、成本和不可逆风险；
6. 必须由有权人回答的问题。

计划命令不得写成已执行证据。
```

### 2.2 Baseline 与范围评估

```text
只执行授权包 <AUTH-ID> 中列出的无副作用 baseline。

逐命令记录 repository、cwd、完整 SHA、工具版本、时间、exit code 和日志引用。
既有失败与本需求风险分开；禁止通过重跑、忽略退出码或修改代码把 baseline 涂绿。
根据实际结果复核 Profile、Feature size、依赖和是否拆 Epic。
```

### 2.3 设计任务

```text
基于已通过的 G1 subject <SUBJECT-ID> 起草设计，不实现。

覆盖正常/失败状态、并发/幂等/超时/取消/重试、权限/租户/审计、数据演进、
contract/consumer 兼容、AI/外部系统边界、观测、成本、rollout 与恢复。
以 `04-contract-change-plan.md` 作为索引，为每个 boundary 建独立 `boundaries/<BND-ID>.md` 和 G2C 输入，为每个 slice 建依赖、验证和授权模板。

对 controlled 或跨仓需求先设计 walking skeleton。
未知选项列入决策，不替 Owner 选择。
```

### 2.4 Walking skeleton

```text
实现 <Feature>/<Slice> 的最窄端到端骨架，授权包 <AUTH-ID>。

只接通一个可验证、默认关闭、无危险副作用的路径；验证契约生成、不可变 pin、
provider/consumer、身份、环境与观测假设。不得扩展成完整功能，不得跳过该 slice 的 G3。
若需要真实账户、外部写、付费调用、部署或 migration，停止并申请新授权。
```

### 2.5 单切片实现

```text
实现 <Feature ID> / <Slice ID>，authorization packet = <AUTH-ID>。

Subject：<requirements/design/contract/code exact refs>
允许：<repositories and paths/actions>
禁止：<explicit exclusions>
前置 Gate：<G2 and relevant G2C IDs>
验证：<commands, thresholds, evidence kinds>
停止/失效：<scope/SHA/dependency/environment/risk changes>

1. 复核 subject、工作区和用户已有改动。
2. 先补能揭示错误的测试，或记录无法 test-first 的原因。
3. 只做当前 slice 的最小实现；不手改生成物。
4. 运行授权范围内的验证，检查完整 diff 与 Git 状态。
5. 把真实结果追加到 evidence.yaml；`not_run` 保持 `not_run`。
6. 报告新风险、未执行项和是否需要使旧决定失效。

禁止自行执行 push/PR/tag、真实数据、外部写、付费调用、部署、migration 或不可逆动作。
```

G2 必须先授权整个 Feature 的有界构建计划；G2C 随后逐 Boundary 解锁依赖它的 Slice。实施前同时确认 Slice 的 `depends_on` 前置、对应 `slice_digest`、代码 refs 和 G2 packet 均未漂移。

### 2.6 反例导向测试

```text
根据 AC、风险和设计检查测试缺口，不修改验收标准来迁就实现。

覆盖适用项：happy path、边界/非法输入、权限/跨租户、重复/并发/幂等、
超时/取消/断线/重试/部分失败、unknown enum/event/field、
新旧 reader/writer、回滚、secret/PII 脱敏、AI Eval 与成本/延迟阈值。

逐项说明对应 AC/风险、测试层、fixture/dataset、环境、失败时能发现的缺陷和 evidence kind。
```

### 2.7 独立视角 Review

```text
只读审查 <subject exact refs>、需求、设计、完整 diff、测试与 evidence，不修改代码、不批准 Gate。

优先查找：错误结果、越权/跨租户、数据损坏、不可恢复、contract/migration/DAG 顺序、
consumer 兼容、真实路径未验证、测试与实现共享错误假设、placeholder/mock 进入目标路径、
日志/指标/审计/kill switch 缺口。

每个发现给严重度、证据、触发条件、影响和验证建议；无发现时说明范围和残余风险。
输出仅作为 evidence，由有权人决定 Gate。
```

### 2.8 发布 DAG 审查

```text
基于 G4 精确制品和目标环境事实审查发布 DAG，不执行发布。

对每个节点列：输入/输出、前置、安全不变量、authorization、执行人、验证、观察窗口、
停止条件、补偿/rollback/roll-forward。检查所有新旧 app/data/contract 组合。
不要默认 deploy→migrate 或 migrate→deploy；按兼容与数据安全推导顺序。
```

### 2.9 证据整理

```text
仅根据本轮实际工具输出提出 evidence 追加项，并更新可读报告。

不得：编造命令/exit code/SHA/tag/digest；把计划写成结果；把静态检查写成集成；
把 mock 写成真实依赖；把部署命令 exit 0 写成 outcome verified；改写旧账本记录。
```

## 3. Authorization packet 规则

一个有效 packet 必须足够窄，使另一个执行者不需要猜权限：

- **对象**：Feature、slice、canonical repository identity、完整 base/head SHA、repo 内结构化路径；
- **动作**：policy capability enum 中允许读取/修改/运行的精确类别；
- **边界**：禁止路径、环境、账户、数据、费用和外部副作用；
- **前置**：有效 Gate/decision、contract/digest、工作区状态；
- **证据**：必须运行的命令、阈值、日志/制品位置；
- **时间**：issued_at、expires_at；
- **停止**：何时立即停、找谁升级；
- **失效**：subject、范围、依赖、环境或风险如何变化时作废。

包可以授权局部代码编辑和无副作用验证，但下列动作必须单独获得针对精确目标的新授权：

- 远端写、PR、merge、push、tag、release；
- 真实数据或真实用户账户；
- 外部写、消息发送、购买/付费调用；
- staging/production 部署、流量和 flag 修改；
- migration、回填、删除、批量覆盖和不可逆动作。

“G2 已过”“任务要求交付”或“这是正常实现步骤”不能替代这些授权。

G2 packet 必须显式列出全部获准 instances、repositories、`{repository,path}`、每仓 base refs、`environment: local_engineering`、`account: null`、data classification/budget、allowed/excluded canonical capabilities、required evidence、stop conditions 和 `reauthorize_on`。一个 packet 可覆盖多个 Slice，执行轮次仍只处理指定 Slice；`account: null` 明确不授权真实外部账号。repository 的 `name/root/url` 必须匹配项目 `.feature-delivery/repository-registry.yaml`：`managed` 只用于项目根内登记路径，`external` 只用于显式登记的单层项目外 checkout；相邻路径可以登记，未登记/隐式拓扑和多层项目外跳转不得使用。Authorization path 只允许 repo 内相对路径，且精确等于 Slice scope。`.` 整仓 scope 需要 justification，`controlled`/高风险还需逐仓 exception Evidence。有效能力是 packet 与 Gate 策略允许集的交集并扣除禁止集；不得通过同义自由文本或 Profile 改名获得宽授权。

## 4. 小步与依赖图

Codex 每轮只承担一个主要认知目标，例如定义一个 boundary、实现一个 use case、接一个 consumer、补一类失败测试或完成一个 release DAG 节点。

出现下列信号时继续拆分或提升 Profile：

- 同时跨越多个职责层、仓库或信任边界；
- 一个 diff 无法由 Reviewer 一次理解；
- 同时新增依赖、contract、migration、API、UI 和启用；
- 验证依赖多个环境且无法单独复现；
- 外部副作用、费用或不可逆范围扩大；
- Codex 开始“顺便”重构无关代码。

`controlled`/跨仓需求先做 walking skeleton，再沿 slice DAG 推进。不要最后一天才首次集成。

## 5. Diff 审查顺序

每个 slice 至少检查：

1. `git status`：用户已有改动和意外文件；
2. `git diff --stat`：范围是否符合 packet；
3. `git diff --check`：空白、冲突标记和机械问题；
4. 完整 diff：AC、状态、错误、权限、数据和副作用；
5. 权威源与生成物：是否由锁定 generator 产生；
6. 依赖/lockfile：是否有意、可追溯和经过供应链判断；
7. migration：滚动兼容、锁/资源、暂停恢复和不可逆点；
8. 测试：实现错误时是否真的失败，是否只证明 mock；
9. 日志/trace/audit：可运维且不泄露 secret/PII；
10. manifest/账本/文档：当前声明与实际 subject 一致。

## 6. 并行 Agent

适合并行的是互不写同一事实源的调查或审查，例如代码路径、契约兼容、安全与测试缺口。使用共享工作区时：

- 文件写范围必须互斥；
- 每个 Agent 开始/结束都核对状态；
- 主 Agent 负责整合、冲突、完整 diff 和验证；
- 子 Agent 结论仍需核对，不能自动成为批准；
- 不并行写同一 migration、Schema 或 append-only 账本。

多 Agent 不等于独立人类 Review。`decisions.yaml` 必须准确记录真正 actor/roles。

## 7. 反幻觉与准确交接

Codex 必须遵守：

1. 未打开的文件内容不当作事实；
2. 未实际执行的工具/命令不声称执行；
3. 无输出、exit code 和精确 subject 不声称测试通过；
4. 无远端/环境事实不声称已发布；
5. 无目标环境 smoke/观察不声称 G6；
6. 无 Eval/dataset 版本不声称 AI 质量提升；
7. 无精确授权不访问真实数据、外部写、付费服务或生产；
8. 冲突时停止并请求有权决策；
9. `ELIGIBLE` 不说成 APPROVED，Review evidence 不说成批准；
10. subject 变化时报告 stale，不沿用旧绿色。

追加 evidence 前还要核对：`started_at ≤ finished_at ≤ recorded_at` 且不在未来；repository/code SHA/base SHA 与对应 Slice/Gate 一致；AC 覆盖不靠名称推断；目标环境证据不得用 local 结果代替；被 passed Decision 引用的成功证据带有 digest，且 artifact 保留期覆盖 `valid_until`。所有 Decision state 的 `decided_at` 均不得在未来，非空 `valid_until` 必须晚于它。

Decision 中的 actor 必须是可追溯人类，roles 必须是其在 manifest 已分配角色的子集；`passed` 还必须由受保护 trust root 中 scope 匹配的 Ed25519 key 验签。Codex/Agent 只能生产 evidence 或 `attestation: null` 的决策草案，不能读取/生成/使用审批私钥，不能运行签名来替人批准，也不能伪造 actor、roles 或 APPROVED。

交接时以 Gate 和实例表达实际结果，例如“G3/SLC-001 passed，SLC-002 blocked：缺 E-17；G4 尚未评估”，而不是笼统写“需求已完成”。
