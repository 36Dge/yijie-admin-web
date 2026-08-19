# Contributing

## 开发流程

1. 从 `main` 拉分支；
2. 新需求先用 `docs/dev/codex-feature-delivery/scripts/new-feature.sh` 创建 `schema_version: 2` Package，owner 固定为 `36Dge`；
3. G0/G1/G2 与当前 Slice 的全部适用 G2C 有效通过后，才修改页面、状态或 API 实现；
4. 涉及接口时先更新 `yijie-contracts` 并固定不可变引用；
5. 逐 Slice 完成 G3，整体完成 G4；
6. 运行 `pnpm lint` 和 `pnpm build`；
7. 提交 PR，要求普通 `web` CI 与 `feature-delivery/trusted-coverage-status` 同时通过。

## Commit 规范

- `feat:` 新功能
- `fix:` 修复
- `docs:` 文档
- `refactor:` 重构
- `test:` 测试
- `chore:` 工程化
