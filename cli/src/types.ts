export interface Config {
  VPS1_IP: string
  VPS1_HOSTNAME: string
  VPS2_IP: string
  VPS2_HOSTNAME: string
  SSH_KEY_PATH: string
  SSH_USER: string
  SSH_PORT: string
  NETWORKING_OPTION: string
  OPENCLAW_DOMAIN: string
  DOMAIN_GRAFANA: string
  // Optional fields accessed via get()
  [key: string]: string
}

export type VpsTarget = 'vps1' | 'vps2' | 'both'

export interface CheckResult {
  name: string
  target: VpsTarget
  ok: boolean
  detail: string
}

export interface SshResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}
