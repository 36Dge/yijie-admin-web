# {{FEATURE_ID}} — Boundary 索引

| 元数据 | 值 |
|---|---|
| Purpose | 导航每个 Boundary 的独立权威规范和 G2C 实例 |
| Authority | 本文是 index，Boundary 当前声明以 `feature.yaml` 为准，语义以对应 `boundary_spec` 为准 |
| 适用范围 | 至少一个已声明 Boundary / 全部 Target；无实例时 artifact 非适用且文件缺席 |
| 完成时点 | 首个 Boundary materialize 时建立；G2 前索引与 manifest 一致 |

> 本文不得成为多个 Boundary 共享的契约规范，也不复制证据或 G2C 状态。每个已声明 Boundary 必须独占一个 `boundaries/<BND-ID>.md`。

## 1. Boundary 导航

| Boundary ID | Type / Impact | Manifest artifact ID | 独立规范 | Producer / 已知受支持 Consumers | Owner |
|---|---|---|---|---|---|
{{BOUNDARY_INDEX_ROWS}}

每行必须与 `feature.yaml.boundaries[]` 一致：`artifact_id` 指向唯一、`authority: normative`、`kind: boundary_spec` 的 artifact，路径固定为 `boundaries/<BND-ID>.md`。不得让两个 Boundary 共用同一 artifact，也不得让 Boundary 指向本索引。

无受影响 Boundary 时不 materialize 本索引，artifact manifest 保持策略允许的 `conditional|not_applicable` 及理由；不创建假 Boundary 或假 G2C 决策。

## 2. 独立规范建立命令

```bash
node ./scripts/materialize-boundary.mjs <package> <BND-ID>
```

命令只对 manifest 已声明的 Boundary 创建对应规范。创建后补齐该文件的权威源、语义、consumer 支持基线、兼容矩阵、演进 DAG、恢复和验证计划。
运行前先以约定 forward ref 声明 `artifact_id: ART-BOUNDARY-<BND-ID>`。短暂的未解析 forward ref 会被 evaluator fail-closed，不得提交或用于 Gate；materializer 原子创建文件/artifact 并回写同一 ID。

## 3. G2 与 G2C 边界

- G2 先绑定 `build_digest` 并授权整个 Feature 的有界构建计划。
- G2C 后绑定单个 `boundary_digest`，只证明该 Boundary 已就绪。
- 某 G2C 只解锁 `slices[].boundary_ids` 引用该 ID 的 Slice，不阻塞无关 Slice，也不扩大 G2 Authorization Packet。
- 独立规范、权威源、consumer 基线或 generator pin 改变时，只使相关 G2C、依赖 G3 和后续集成决策失效。

## 4. 一致性复核

- [ ] 索引中的 ID、type、impact、artifact ID 与 manifest 一致
- [ ] 每个受影响 Boundary 的规范存在、在包内且不是符号链接
- [ ] 每个 Boundary 独占 artifact/path，没有跨实例别名
- [ ] 索引未复制规范语义、Evidence 结果或 Gate 当前状态

本文的勾选不产生批准；evaluator 计算实例资格，有权人只在 `decisions.yaml` 追加决定。
