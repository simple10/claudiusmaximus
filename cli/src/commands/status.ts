import type { Config, CheckResult } from '../types.ts';
import { sshSafe, dockerComposeSafe, gatewayExecSafe } from '../ssh.ts';
import { header, printResults } from '../ui.ts';

async function check(
  name: string,
  target: 'vps1' | 'vps2',
  fn: () => Promise<{ ok: boolean; detail: string }>
): Promise<CheckResult> {
  try {
    const { ok, detail } = await fn();
    return { name, target, ok, detail };
  } catch (err) {
    return { name, target, ok: false, detail: String(err) };
  }
}

export async function statusDashboard(cfg: Config): Promise<void> {
  header('Status Overview');
  console.log('  Running checks on both VPSs...\n');

  const results = await Promise.allSettled([
    // VPS-1 checks
    check('SSH connectivity', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'echo ok');
      return { ok: r.ok, detail: r.ok ? 'Connected' : r.stderr };
    }),
    check('WireGuard', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo wg show wg0 2>/dev/null | grep -c "latest handshake"');
      const hasHandshake = r.ok && r.stdout.trim() !== '0';
      return { ok: hasHandshake, detail: hasHandshake ? 'Active' : 'No handshake' };
    }),
    check('Gateway container', 'vps1', async () => {
      const r = await dockerComposeSafe(cfg, 'vps1', 'ps --format json');
      if (!r.ok) return { ok: false, detail: 'compose ps failed' };
      const running = r.stdout.includes('"running"') || r.stdout.includes('Up');
      return { ok: running, detail: running ? 'Running' : 'Not running' };
    }),
    check('Gateway health', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:18789/health');
      return { ok: r.ok, detail: r.ok ? r.stdout.slice(0, 50) : 'Unreachable' };
    }),
    check('Node Exporter', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:9100/metrics | head -1');
      return { ok: r.ok, detail: r.ok ? 'Serving metrics' : 'Unreachable' };
    }),
    check('Promtail', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=promtail --format "{{.Status}}"');
      const up = r.ok && r.stdout.includes('Up');
      return { ok: up, detail: up ? r.stdout : 'Not running' };
    }),

    // VPS-2 checks
    check('SSH connectivity', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'echo ok');
      return { ok: r.ok, detail: r.ok ? 'Connected' : r.stderr };
    }),
    check('WireGuard', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'sudo wg show wg0 2>/dev/null | grep -c "latest handshake"');
      const hasHandshake = r.ok && r.stdout.trim() !== '0';
      return { ok: hasHandshake, detail: hasHandshake ? 'Active' : 'No handshake' };
    }),
    check('Monitoring containers', 'vps2', async () => {
      const r = await dockerComposeSafe(cfg, 'vps2', 'ps --format "{{.Name}} {{.Status}}"');
      if (!r.ok) return { ok: false, detail: 'compose ps failed' };
      const lines = r.stdout.split('\n').filter(Boolean);
      const allUp = lines.length > 0 && lines.every((l) => l.includes('Up'));
      return { ok: allUp, detail: `${lines.length} services${allUp ? ' all up' : ', some down'}` };
    }),
    check('Prometheus', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.2:9090/api/v1/targets | head -c 200');
      return { ok: r.ok, detail: r.ok ? 'Responding' : 'Unreachable' };
    }),
    check('Loki', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.2:3100/ready');
      return { ok: r.ok, detail: r.ok ? r.stdout.slice(0, 30) : 'Not ready' };
    }),
    check('Grafana', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3000/api/health');
      return { ok: r.ok, detail: r.ok ? 'Healthy' : 'Unreachable' };
    }),
    check('Tempo', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3200/ready');
      return { ok: r.ok, detail: r.ok ? 'Ready' : 'Not ready' };
    }),
    check('Alertmanager', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:9093/-/healthy');
      return { ok: r.ok, detail: r.ok ? 'Healthy' : 'Unreachable' };
    }),
  ]);

  const checks = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: 'Unknown', target: 'vps1' as const, ok: false, detail: String(r.reason) }
  );

  printResults(checks);
}
