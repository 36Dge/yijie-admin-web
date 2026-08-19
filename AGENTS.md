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

## Feature Delivery v2 强制入口

任何新增或改变 Admin Web 能力、可观察行为、API/浏览器持久状态 Boundary、风险处置或发布结果的工作，在修改业务实现前必须使用 `docs/dev/codex-feature-delivery/scripts/new-feature.sh` 创建 `schema_version: 2` Feature Package。canonical actor/owner 固定为 `36Dge`，最小 repo 内 scope 必须显式给出；禁止复制历史 v1 Package 或继承旧 G2A/G3/G4。

创建和填写 Package、只读调查不构成实现授权。实现前必须有有效 G0、G1、G2 以及当前 Slice 依赖的全部逐 Boundary G2C；每个 Slice 通过 G3，整体工程通过 G4。`local_engineering` 到 G4 终止；staging/production 必须继续 G5/G6，且当前最小权限 key 不覆盖这些范围。所有实现 PR 必须同时通过普通 `web` CI 和 `feature-delivery/trusted-coverage-status`。

Codex 可以调查、起草 Package、追加真实 Evidence 和准备未签 Decision，但不得读取、复制、移动或使用审批私钥，不得替人工签名、自批 Gate 或把 `ELIGIBLE` 写成 `passed`。在本仓 App、Environment、required status、branch protection、普通 CI 与 canary 全部接通前，本仓保持 `NOT_READY`，只允许只读调查和 v2 接入工作。
