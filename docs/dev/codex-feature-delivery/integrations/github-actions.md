# GitHub Actions 接入指南

本文描述可选的 GitHub enforcement adapter。它是接入示例，不会因运行初始化器而自动上线。核心规范见 [HANDBOOK.md](../HANDBOOK.md)，Git 对象算法见 [git.md](git.md)。

## 1. 初始化器会做什么

使用 Node.js 24–26。先安装发行源依赖：

```bash
(cd "<DISTRIBUTION_ROOT>" && npm ci --ignore-scripts)
```

再从发行源初始化：

```bash
node <DISTRIBUTION_ROOT>/scripts/init-project.mjs \
  --project-root <PROJECT_ROOT> \
  --project-id <PROJECT_ID> \
  --repository-id <REPOSITORY_ID> \
  --actor-id <ACTOR_ID> \
  --ci github
```

初始化器从 `<DISTRIBUTION_ROOT>` 原子复制发行包到项目 `<FRAMEWORK_ROOT>`，并从发行源的 `integrations/github/` 物化候选 workflow/config 和项目治理文件。成功后安装项目内依赖：

```bash
(cd "<FRAMEWORK_ROOT>" && npm ci --ignore-scripts)
```

初始化器不会也不能自动完成：

- 创建 GitHub App；
- 写入 App private key；
- 创建或保护 Environment；
- 设置 repository variables；
- 修改 branch protection 或 ruleset；
- 设置 required status expected source；
- 开启或关闭 merge queue。

这些都是管理员在 GitHub 控制面执行的外部动作。完成前不得宣称 required enforcement 已启用。

## 2. 信任模型

required workflow 必须：

1. 在 `pull_request_target` 事件中只 checkout 受保护 target-base SHA；
2. 从 target base 执行 verifier、Schema 和 policy；
3. fetch 后证明 PR ref commit 精确等于事件的 `head.sha`；
4. 只把候选 head 作为 Git objects 解析，不 checkout、不执行候选脚本；
5. 用短期、最小权限 GitHub App token 向精确 head 发布独立 status；
6. token 签发、验证或 status 发布失败时 fail closed。

默认 `GITHUB_TOKEN` 应保持只读。专用 App 只需要 `Commit statuses: write`，不要授予内容写入、PR 修改或管理权限。

## 3. 管理员配置

名称应由项目配置确定；以下仅为示例：

| 对象 | 示例值 | 要求 |
|---|---|---|
| Environment | `feature-delivery-trusted` | 仅受保护 base 分支可访问 |
| Required status | `feature-delivery/trusted-coverage-status` | expected source 固定到专用 App |
| App client variable | `CFD_STATUS_APP_CLIENT_ID` | PR 不可写 |
| App private-key secret | `CFD_STATUS_APP_PRIVATE_KEY` | 仅受保护 Environment 可读 |
| Bootstrap digest | `CFD_FEATURE_DELIVERY_BOOTSTRAP_DIGEST` | 一次性接入，由管理员预先写入 |
| Governance digest | `CFD_FEATURE_DELIVERY_GOVERNANCE_DIGEST` | TCB 变更时由管理员写入精确摘要 |

branch protection 或 ruleset 必须：

- 要求独立 status context；
- 将 expected source 固定到专用 App；
- 要求分支基于最新受保护 base；
- 禁止普通开发者绕过；
- 避免把归属 base SHA 的 workflow job check 误当成候选 head required status。

## 4. Bootstrap

首次接入时，target base 可能尚无 workflow 或 coverage policy。候选 head 不能用自己新增的 verifier 自证。

管理员必须从已审查、不可变的外部 verifier 独立复算初始 change-set digest，并把同一值预先写入受保护 repository variable。若 base 尚无可执行 workflow，则使用组织级 required workflow、专用 App webhook，或管理员控制的离线验证完成首次合并。

首次接入合并后，后续 CI 永远优先使用 target-base 版本。bootstrap pin 不得成为普通 Feature 的长期豁免。

## 5. Trust root 与 TCB 轮换

首个审批 key、key 轮换，以及 workflow、scripts、schemas、policies、trust root、repository registry 和依赖锁等 TCB 变更必须使用隔离变更集：

1. base policy 把全部候选路径归类为 external-digest-only；
2. 管理员在 PR 外复核并登记精确 change-set digest；
3. base-trusted checker 校验 digest 和候选文件结构；
4. 变更中不得混入 Feature 实现或账本更新。

普通 G4、PR 批准或 head 中新增的 key 都不能替代第二通道。

## 6. PR retarget 与状态竞态

workflow 应监听会改变 base 语义的事件，包括 PR `edited`/retarget，并在取得 App token 后尽快把事件 head 状态写为 pending。GitHub commit status 以 SHA 为键，不以 PR/base 组合为键，因此治理上禁止在旧 success 尚未被新事件覆盖时跨 PR 或 base 重用同一 head。

需要完全消除事件竞态时，应使用专用 App webhook 或组织级 required workflow 执行相同的 base-trusted 算法，而不是放宽检查。

## 7. Merge queue

本发行版默认不提供 `merge_group` verifier。启用 merge queue 前，管理员必须部署同等 base-trusted 的 `merge_group` 验证和 status 发布；在此之前保持 merge queue 禁用。缺少 required context 时必须 fail closed。

## 8. 上线验收

- [ ] workflow 从 target base 运行，候选脚本从未被执行
- [ ] App 只有 Commit statuses 写权限
- [ ] Environment 与 secrets 只对受保护 base 可用
- [ ] required status expected source 固定到 App
- [ ] branches-up-to-date 已启用且 bypass 已移除
- [ ] bootstrap/governance digest 不能由 PR 修改
- [ ] retarget 会使旧状态失效或立即变为 pending
- [ ] token/status 发布故障实际阻塞合并
- [ ] merge queue 保持禁用，或已有等价 `merge_group` verifier

完成所有检查后，才可以声明 GitHub required enforcement 已上线。
