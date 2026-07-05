# Architecture

`yijie-admin-web` 是内部管理后台。它通过 `yijie-api` 访问租户、权限、插件、知识库、审计和运营数据，通过 `yijie-contracts` 生成的类型保持 API 契约一致。UI 组件库使用 Element Plus。

## 目录

- `src/router/`：路由；
- `src/stores/`：Pinia 状态；
- `src/pages/`：页面；
- `src/api/`：API client；
- `src/domain/`：后台领域模型；
- `src/components/`：共享组件。
