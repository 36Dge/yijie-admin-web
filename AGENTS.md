# AGENTS.md

## 仓库职责

`yijie-admin-web` 是易界 AI 内部管理后台，负责租户、用户、RBAC、店铺授权查看、平台配置、Skill / Plugin 管理、知识库管理、Agent 任务审计、工具调用审计和运营管理。

## 禁止事项

- 不实现卖家桌面端体验；
- 不实现连接器执行逻辑；
- 不持久化平台 token；
- 不绕过后端权限校验；
- 不手写重复 DTO，涉及 API 时先更新 `yijie-contracts`。

## 技术栈

Vue 3、Vite、TypeScript、Pinia、Vue Router、pnpm。

## 开发命令

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
```

## 测试要求

当前最小骨架使用 `vue-tsc` 做类型检查。后续新增复杂页面后补充单元测试和 e2e smoke。

## 安全要求

所有管理操作必须依赖后端 RBAC 和审计。前端不得保存平台 access token、refresh token、cookie 或真实商家敏感数据。
