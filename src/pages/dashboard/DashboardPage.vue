<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAppStore } from '../../stores/app'
import { adminRepositorySummaries } from '../../domain/repositories'

const appStore = useAppStore()
const { productName, environment } = storeToRefs(appStore)
</script>

<template>
  <main class="admin-shell">
    <aside class="sidebar">
      <strong>{{ productName }}</strong>
      <nav>
        <a href="#overview">总览</a>
        <a href="#tenants">租户</a>
        <a href="#skills">Skills</a>
        <a href="#knowledge">知识库</a>
        <a href="#audit">审计</a>
      </nav>
    </aside>

    <section class="workspace">
      <header>
        <div>
          <p class="eyebrow">Local Environment: {{ environment }}</p>
          <h1>管理后台工程骨架</h1>
        </div>
      </header>

      <section id="overview" class="panel">
        <h2>职责边界</h2>
        <p>Admin Web 只负责内部治理和运营管理，不承载卖家桌面端体验或连接器执行逻辑。</p>
      </section>

      <section class="grid">
        <article v-for="repo in adminRepositorySummaries" :key="repo.name" class="panel">
          <p class="eyebrow">{{ repo.owner }}</p>
          <h2>{{ repo.name }}</h2>
          <p>{{ repo.purpose }}</p>
        </article>
      </section>
    </section>
  </main>
</template>

<style scoped>
.admin-shell {
  display: grid;
  min-height: 100vh;
  grid-template-columns: 240px 1fr;
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

nav {
  display: grid;
  gap: 10px;
}

nav a {
  color: #c8d1dc;
  text-decoration: none;
}

.workspace {
  padding: 32px;
}

header {
  display: flex;
  justify-content: space-between;
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
  font-size: 18px;
}

.eyebrow {
  color: #3b6ea8;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.panel {
  padding: 20px;
  border: 1px solid #dbe2ef;
  border-radius: 8px;
  background: #ffffff;
}

.panel p:last-child {
  margin-bottom: 0;
  color: #5b6472;
}

@media (max-width: 760px) {
  .admin-shell {
    grid-template-columns: 1fr;
  }

  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
