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

## 安全要求

Admin Web 不保存平台 token，不作为权限真相。权限、审批和审计必须由 `yijie-api` 提供。
