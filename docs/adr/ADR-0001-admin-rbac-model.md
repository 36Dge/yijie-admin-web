# ADR-0001: Admin RBAC 由后端作为权限真相

## 状态

Accepted

## 日期

2026-07-04

## 背景

Admin Web 需要管理租户、用户、插件、知识库和审计，权限边界必须统一。

## 决策

前端只消费 `yijie-api` 返回的权限和菜单，不在前端硬编码权限真相。

## 影响

所有权限相关 API 变更必须先更新 `yijie-contracts`。
