<script setup lang="ts">
import { storeToRefs } from 'pinia'
import {
  ElAside,
  ElCard,
  ElCol,
  ElContainer,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElRow,
  ElTag,
} from 'element-plus'
import 'element-plus/es/components/aside/style/css'
import 'element-plus/es/components/card/style/css'
import 'element-plus/es/components/col/style/css'
import 'element-plus/es/components/container/style/css'
import 'element-plus/es/components/main/style/css'
import 'element-plus/es/components/menu/style/css'
import 'element-plus/es/components/menu-item/style/css'
import 'element-plus/es/components/row/style/css'
import 'element-plus/es/components/tag/style/css'
import { useAppStore } from '../../stores/app'
import { adminRepositorySummaries } from '../../domain/repositories'

const appStore = useAppStore()
const { productName, environment } = storeToRefs(appStore)

const navItems = [
  { index: 'overview', label: '总览' },
  { index: 'tenants', label: '租户' },
  { index: 'skills', label: 'Skills' },
  { index: 'knowledge', label: '知识库' },
  { index: 'audit', label: '审计' },
]
</script>

<template>
  <el-container class="admin-shell">
    <el-aside class="sidebar" width="240px">
      <strong>{{ productName }}</strong>
      <el-menu class="nav-menu" default-active="overview">
        <el-menu-item v-for="item in navItems" :key="item.index" :index="item.index">
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-main class="workspace">
      <header class="page-header">
        <div>
          <p class="eyebrow">Local Environment: {{ environment }}</p>
          <h1>管理后台工程骨架</h1>
        </div>
        <el-tag type="success" effect="plain">Element Plus</el-tag>
      </header>

      <el-card id="overview" shadow="never">
        <template #header>
          <h2>职责边界</h2>
        </template>
        <p>Admin Web 只负责内部治理和运营管理，不承载卖家桌面端体验或连接器执行逻辑。</p>
      </el-card>

      <el-row :gutter="16" class="repo-grid">
        <el-col v-for="repo in adminRepositorySummaries" :key="repo.name" :xs="24" :md="8">
          <el-card shadow="never" class="repo-card">
            <p class="eyebrow">{{ repo.owner }}</p>
            <h2>{{ repo.name }}</h2>
            <p>{{ repo.purpose }}</p>
          </el-card>
        </el-col>
      </el-row>
    </el-main>
  </el-container>
</template>

<style scoped>
.admin-shell {
  min-height: 100vh;
}

.sidebar {
  padding: 24px;
  color: #ffffff;
  background: #17202a;
}

.sidebar strong {
  display: block;
  margin-bottom: 28px;
  font-size: 18px;
}

.nav-menu {
  border-right: 0;
  background: transparent;
}

.nav-menu :deep(.el-menu-item) {
  height: 40px;
  color: #c8d1dc;
  border-radius: 6px;
}

.nav-menu :deep(.el-menu-item.is-active),
.nav-menu :deep(.el-menu-item:hover) {
  color: #ffffff;
  background: rgba(255, 255, 255, 0.12);
}

.workspace {
  padding: 32px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  font-size: 30px;
}

h2 {
  margin-bottom: 0;
  font-size: 18px;
}

.eyebrow {
  color: #3b6ea8;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.repo-grid {
  margin-top: 16px;
}

.repo-card {
  min-height: 150px;
}

.repo-card p:last-child,
.el-card p:last-child {
  margin-bottom: 0;
  color: #5b6472;
}

@media (max-width: 760px) {
  .admin-shell {
    display: block;
  }

  .sidebar {
    width: 100% !important;
  }
}
</style>
