import { defineStore } from 'pinia'

export const useAppStore = defineStore('app', {
  state: () => ({
    environment: 'local',
    productName: '易界 AI Admin',
  }),
})
