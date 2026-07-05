export interface HealthStatus {
  service: string
  status: 'ok' | 'degraded'
}

export async function getHealth(): Promise<HealthStatus> {
  return {
    service: 'yijie-admin-web',
    status: 'ok',
  }
}
