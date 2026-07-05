export interface AdminRepositorySummary {
  name: string
  owner: string
  purpose: string
}

export const adminRepositorySummaries: AdminRepositorySummary[] = [
  {
    name: 'yijie-api',
    owner: 'Backend Team',
    purpose: '租户、权限、店铺授权、任务、审计和业务 API',
  },
  {
    name: 'yijie-skills',
    owner: 'AI Product Team',
    purpose: 'Skill、Plugin、Prompt Pack 和评测治理',
  },
  {
    name: 'yijie-knowledge',
    owner: 'Data AI Team',
    purpose: '知识源、知识版本、检索质量和 citation 管理',
  },
]
