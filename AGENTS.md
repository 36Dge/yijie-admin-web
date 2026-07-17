# AGENTS.md

## 适用范围

本文件适用于 `yijie-admin-web` 整个仓库。目录中若出现更具体的 `AGENTS.md`，修改对应目录时以更具体的规则为准。

## 仓库职责

`yijie-admin-web` 是易界 AI 内部管理后台，负责租户、用户、RBAC、店铺授权查看、平台配置、Skill/Plugin 管理、知识库管理、Agent 任务审计、工具调用审计和运营管理。

技术栈为 Vue 3、Vite、TypeScript、Pinia、Vue Router、Element Plus 和 pnpm。

## 仓库边界

- 不实现卖家桌面端体验、连接器执行逻辑或 Runtime 能力；
- 不直接访问数据库、Redis 或第三方电商平台 API；
- 不持久化平台 token、refresh token、cookie、生产凭据或真实商家敏感数据；
- 不把前端路由守卫、按钮显隐或 Pinia 状态当成授权依据；
- 不在未更新 `yijie-contracts` 的情况下自行定义真实 API 行为。

## 当前实现状态

- 当前只有登录页、Dashboard、基础路由、store 和 API client 骨架；
- `src/api/client.ts` 当前返回占位响应，不代表认证、权限或真实后端已经接通；
- `pnpm generate` 当前是占位命令，不代表 SDK 已经生成；
- 前端鉴权、后端 RBAC、审计和会话机制尚未形成完整闭环，不能基于页面外观声称已具备安全控制。

## 代码组织

- `src/pages/`：路由级页面、工作流组合和页面状态；
- `src/components/`：跨页面复用的展示或领域 UI，不直接承担 API 副作用；
- `src/stores/`：跨页面共享状态和会话视图，不作为权限真相源；
- `src/api/`：HTTP I/O、契约适配、错误映射和请求取消；
- `src/domain/`：与 Vue 和传输协议解耦的领域类型、端口和纯逻辑；
- `src/router/`：路由定义、导航和面向体验的访问提示；
- `src/style.css`：全局基础样式，页面特有样式保持局部作用域。

页面负责组合，API 层负责 I/O，store 管理真正共享的状态。不要让组件直接拼接后端协议，也不要为了单个页面把所有状态提升为全局状态。

## UI 与交互规则

- Element Plus 是默认组件库，不引入第二套通用 UI 库；
- 优先使用 Element Plus 的成熟交互和可访问能力，只有重复出现的领域语义才封装共享组件；
- 管理后台应紧凑、克制、易扫描，优先表格、筛选、批量操作、状态和审计信息，不采用营销页式布局；
- 页面必须覆盖 loading、empty、error、permission denied 和 ready 状态，并提供清晰的重试或返回路径；
- 创建、删除、禁用、授权、配置发布等高影响操作必须有确认、明确影响范围和后端审计结果；
- 路由守卫和按钮显隐只改善用户体验，后端必须对每次请求重新鉴权和授权；
- 默认中文文案，表单需要明确 label、校验错误和提交反馈；仅图标按钮必须有可访问名称或 tooltip；
- 不在浏览器日志、错误提示、URL 或埋点中输出凭据、token、PII 或完整商家数据。

## 契约与 API

- 后端契约以 `yijie-contracts` 为源，先修改并评审 OpenAPI/Schema，再运行生成或适配流程；
- 不手写与已发布契约重复的 DTO，不直接编辑生成文件；
- 当前占位 API client 应在接入真实接口时被明确替换或隔离，不能把固定响应留在生产路径；
- 请求层必须统一处理 base URL、超时、取消、错误码、权限拒绝和版本不兼容；
- 前端不直接调用 connectors，也不替后端决定租户、角色、权限或审计策略。

## 认证与安全

认证会话、CSRF、防重放、token/cookie 存储和租户上下文方案必须由用户结合后端设计明确确认，Codex 不得自行选择。不得以 localStorage 存放 access token 作为临时方案。

- 前端展示的权限来自后端，后端始终是授权真相源；
- 高风险操作由后端执行校验、幂等、审批和审计，前端只承接交互；
- `.env` 只保存可公开的前端配置，不放服务端秘密；
- 所有示例和测试数据必须脱敏或合成。

## 必须先确认的决策

- 认证方式、会话载体、租户切换和权限模型；
- 新增依赖、通用 UI 库、状态管理模式或监控/埋点 SDK；
- API 契约变化、破坏性字段变化或跨仓库实现；
- 删除、批量修改、授权、发布等高风险操作的审批与审计规则；
- 任何需要浏览器持久化敏感信息的方案。

## 开发与验证

统一使用 pnpm，不混用 npm 或 yarn。提交 `pnpm-lock.yaml`，不提交 `node_modules/`、`dist/`、本地环境文件或生产凭据。

```bash
pnpm install
make lint
make test
make build
make generate
```

`make generate` 只有在真实生成流程接通后才算契约生成验证。Vue、TypeScript、store、API 或领域逻辑改动应执行 `make lint && make test && make build`。复杂筛选、批量操作、权限状态和高风险流程需要对应单元测试或端到端 smoke；无法执行的浏览器验证必须明确报告。

## 完成标准

- 实现位于正确目录和职责边界，未把权限真相或后端规则搬到前端；
- 契约、客户端和页面状态一致，没有新增重复 DTO 或固定生产响应；
- loading、empty、error、permission denied 和 ready 状态完整；
- 高风险操作具备确认、后端授权和审计承接；
- lint、测试和生产构建通过，界面在目标视口无文本或操作重叠；
- 尚未接通的认证、权限、生成或端到端能力被如实说明。
