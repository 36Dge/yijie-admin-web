# v1 → v2 迁移与共存

本说明只处理历史需求继续演进时的边界；不批量重写既有 Feature Package，也不把缺失的历史证据补造成事实。

全新项目不需要创建 legacy 记录，保持 `.feature-delivery/legacy-v1-allowlist.txt` 为空。项目接入位置和初始化方式见 [PROJECT_ADOPTION.md](PROJECT_ADOPTION.md)。

## 默认策略

- 已关闭或仅供审计的 v1 包保持只读；项目 `.feature-delivery/legacy-v1-allowlist.txt` 逐包 pin basename + 规范化 tree digest，不预设历史包数量。`--allow-legacy` 精确匹配时只返回 `LEGACY_RECOGNIZED` 元数据，`valid=false` 且退出码非零；任何新 v1 或 tree 漂移都拒绝。
- 新需求一律由 `<FRAMEWORK_ROOT>/scripts/new-feature.sh` 创建 v2 包。
- v1 需求若需要新增实现、发布或风险决策，创建新的 v2 Feature ID；在 Brief 的来源中引用旧包路径和最后可信事实。
- 不复制 v1 的自由文本 Gate 状态。只有能定位原始命令、完整版本、actor、时间和结果的记录，才可作为 v2 evidence 的来源；新记录必须标注 provenance。

## 迁移步骤

1. 冻结旧包，记录其路径、Git commit 和已知矛盾；不编辑历史。
2. 用 v2 Intake 重新选择 Profile、Target、size、数据最高分类、依赖、Boundary 和 Slice。
3. 把仍有效的需求转为新 AC；过期、未知或冲突内容进入 Unknown/决策问题。
4. 在当前代码与环境重新执行 baseline。旧测试摘要不能替代新 baseline。
5. 对仍可取回的旧制品计算 digest，并以新 Evidence ID 登记来源；不可取回项保持缺口。
6. 按当前事实重新计算 `intake_digest`、`scope_digest`、`build_digest`，并由当前受保护 trust root 中的有效 key 签署新 Decision；每个受影响 Boundary/Slice 使用新的独立 digest。不得复用 v1 actor 字符串/旧签名、伪造 digest，或因其曾写 “passed” 而跳 Gate。
7. 新包只在 Target 终点有效通过后 materialize Summary；将 lifecycle 改为 `completed` 会自动要求 strict 闭环，不是绕过 Gate 的标签。

## Gate Policy 版本迁移

Gate Policy 升级不要求改写既有 v2 Package，更不能批量替换其 Decision subject：

1. 以最终原始 bytes 准备新 policy，严格通过 `<FRAMEWORK_ROOT>/schemas/gate-policy.schema.json`；
2. 计算 SHA-256，把完全相同的 bytes 新增为 `<FRAMEWORK_ROOT>/policies/<digest-hex>.yaml`；
3. 在同一个受保护、外部 change-set digest 批准的隔离 TCB 变更中，用相同 bytes 覆盖 active `gate-policy.yaml`；不混入 Feature Package/ledger 修改；
4. 运行 registry、evaluator、签名与 materializer 回归；active 没有同 bytes 快照时必须 fail closed；
5. 合并后，新 Package 自动绑定新 active 的 id/version/digest；既有 Package 和已签 Decision 保持原 digest，由 `policies/<old-digest>.yaml` 继续复核。

历史 policy 快照与 v1 tree pin 一样只增不改：禁止覆盖、删除或以“格式化”名义重写。若某个历史快照丢失或 digest/schema/id/version 不一致，对应 Package 保持不可验证，不能退回当前 active 猜测其语义，也不能通过重签掩盖缺口。共享 Gate Policy Schema 的演进必须向后兼容所有仍受支持快照；破坏性 Schema 变化必须先设计内容寻址的 schema 版本路由。

不要在 v1 目录内追加“迁移说明”或新 evidence；这会破坏只读 tree pin。迁移关联只写入新的 v2 Package，并以旧目录路径与已固定 Git provenance 引用。

## 大型历史包

不把数千行 v1 历史塞进新的 manifest。创建一个小型 v2 successor，旧包作为只读参考；只迁移当前范围、未关闭 blocker、仍有效风险和可复核证据。后续执行历史进入 v2 ledgers，不再向旧 Markdown 顶部和末尾双重回填。

## 验收

迁移完成的含义是“后续动作已由 v2 管理”，不是“v1 已被认证”。任何无法证明的旧状态都保持 unknown/blocked，不使用 `N/A` 或新批准覆盖历史空白。
