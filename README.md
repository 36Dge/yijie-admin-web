# yijie-admin-web

易界 AI 内部管理后台，使用 Vue 3、Vite、TypeScript、Pinia、Vue Router 和 pnpm。

## 仓库职责

- 租户、用户和 RBAC 管理；
- 店铺授权查看与撤销；
- 平台 API 配置入口；
- Skill / Plugin 上架、版本和灰度管理；
- 知识库数据源、版本和入库任务管理；
- Agent 任务、工具调用和安全审计；
- 计费套餐与系统运行状态。

## 不负责什么

- 不负责卖家桌面端体验；
- 不负责平台 API 调用实现；
- 不负责知识库入库和检索实现；
- 不负责 Codex Runtime 维护。

## 本地开发

```bash
pnpm install
pnpm dev
```

## 测试与构建

```bash
pnpm lint
pnpm build
```

## Feature Delivery v2

新需求唯一入口是 [`docs/dev/codex-feature-delivery/`](docs/dev/codex-feature-delivery/README.md)。先从本仓 Git worktree 创建 `schema_version: 2` Package，owner 使用 `36Dge`；修改业务实现前完成 G0/G1/G2 和适用 G2C，逐 Slice 完成 G3，整体完成 G4。历史 v1 状态不能继承。普通 `web` CI 与 `feature-delivery/trusted-coverage-status` 都是远端准入条件。

## 安全要求

Admin Web 不保存平台 token，不作为权限真相。权限、审批和审计必须由 `yijie-api` 提供。
