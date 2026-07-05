import { createRouter, createWebHistory } from 'vue-router'
import DashboardPage from '../pages/dashboard/DashboardPage.vue'
import LoginPage from '../pages/login/LoginPage.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/dashboard' },
    { path: '/login', component: LoginPage },
    { path: '/dashboard', component: DashboardPage },
  ],
})
