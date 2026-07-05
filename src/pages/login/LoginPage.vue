<template>
  <main class="login-page">
    <section class="login-panel">
      <p class="eyebrow">Yijie Admin</p>
      <h1>易界 AI 管理后台</h1>
      <p>用于租户、权限、插件、知识库、审计和运营管理。</p>
      <RouterLink class="primary-link" to="/dashboard">进入本地控制台</RouterLink>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 32px;
}

.login-panel {
  width: min(440px, 100%);
  padding: 32px;
  border: 1px solid #dbe2ef;
  border-radius: 8px;
  background: #ffffff;
}

.eyebrow {
  margin: 0 0 12px;
  color: #3b6ea8;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  font-size: 28px;
}

p {
  color: #5b6472;
}

.primary-link {
  display: inline-flex;
  margin-top: 18px;
  color: #ffffff;
  background: #1f6feb;
  border-radius: 6px;
  padding: 10px 14px;
  text-decoration: none;
}
</style>
