import type { Config, CheckResult } from '../types.ts';
import { sshSafe, dockerComposeSafe } from '../ssh.ts';
import { header, printResults } from '../ui.ts';

type Target = 'vps1' | 'vps2';

async function check(
  name: string,
  target: Target,
  fn: () => Promise<{ ok: boolean; detail: string }>
): Promise<CheckResult> {
  try {
    return { name, target, ...(await fn()) };
  } catch (err) {
    return { name, target, ok: false, detail: String(err) };
  }
}

export async function runVerification(cfg: Config): Promise<void> {
  header('Full Verification Suite');
  console.log('  Running all checks from 07-verification.md...\n');

  // 7.1 WireGuard
  const wgChecks = await Promise.all([
    check('WireGuard interface up', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo wg show wg0');
      return { ok: r.ok && r.stdout.includes('peer'), detail: r.ok ? 'Interface active' : 'Down' };
    }),
    check('WireGuard interface up', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'sudo wg show wg0');
      return { ok: r.ok && r.stdout.includes('peer'), detail: r.ok ? 'Interface active' : 'Down' };
    }),
    check('Ping VPS-2 via WireGuard', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'ping -c 1 -W 3 10.0.0.2');
      return { ok: r.ok, detail: r.ok ? 'Reachable' : 'Unreachable' };
    }),
    check('Ping VPS-1 via WireGuard', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'ping -c 1 -W 3 10.0.0.1');
      return { ok: r.ok, detail: r.ok ? 'Reachable' : 'Unreachable' };
    }),
  ]);

  // 7.2 OpenClaw (VPS-1)
  const oclawChecks = await Promise.all([
    check('Gateway containers running', 'vps1', async () => {
      const r = await dockerComposeSafe(cfg, 'vps1', 'ps');
      const up = r.ok && (r.stdout.includes('Up') || r.stdout.includes('running'));
      return { ok: up, detail: up ? 'Running' : 'Not running' };
    }),
    check('Gateway health endpoint', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:18789/health');
      return { ok: r.ok, detail: r.ok ? r.stdout.slice(0, 50) : 'Unreachable' };
    }),
    check('Node Exporter metrics', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'curl -sf http://localhost:9100/metrics | head -1');
      return { ok: r.ok, detail: r.ok ? 'Serving' : 'Unreachable' };
    }),
    check('Promtail running', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=promtail --format "{{.Status}}"');
      const up = r.ok && r.stdout.includes('Up');
      return { ok: up, detail: up ? r.stdout.trim() : 'Not running' };
    }),
  ]);

  // 7.3 Monitoring (VPS-2)
  const monChecks = await Promise.all([
    check('Monitoring containers running', 'vps2', async () => {
      const r = await dockerComposeSafe(cfg, 'vps2', 'ps --format "{{.Name}} {{.Status}}"');
      if (!r.ok) return { ok: false, detail: 'compose ps failed' };
      const lines = r.stdout.split('\n').filter(Boolean);
      const allUp = lines.length > 0 && lines.every((l) => l.includes('Up'));
      return { ok: allUp, detail: `${lines.length} services${allUp ? ' all up' : ''}` };
    }),
    check('Prometheus targets', 'vps2', async () => {
      const r = await sshSafe(
        cfg,
        'vps2',
        `curl -sf http://10.0.0.2:9090/api/v1/targets | python3 -c "import sys,json; d=json.load(sys.stdin); ts=d['data']['activeTargets']; print(f'{sum(1 for t in ts if t[\"health\"]==\"up\")}/{len(ts)} up')" 2>/dev/null`
      );
      return { ok: r.ok && !r.stdout.includes('0/'), detail: r.ok ? r.stdout.trim() : 'Unreachable' };
    }),
    check('Loki readiness', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.2:3100/ready');
      return { ok: r.ok, detail: r.ok ? 'Ready' : 'Not ready' };
    }),
    check('Grafana health', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3000/api/health');
      return { ok: r.ok, detail: r.ok ? 'Healthy' : 'Unreachable' };
    }),
    check('Alertmanager health', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:9093/-/healthy');
      return { ok: r.ok, detail: r.ok ? 'Healthy' : 'Unreachable' };
    }),
  ]);

  // 7.4 Cross-VPS metrics
  const crossChecks = await Promise.all([
    check('VPS-1 metrics reachable from VPS-2', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://10.0.0.1:9100/metrics | head -1');
      return { ok: r.ok, detail: r.ok ? 'Reachable' : 'Unreachable' };
    }),
  ]);

  // 7.4a OTEL signals
  const otelChecks = await Promise.all([
    check('Tempo ready', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'curl -sf http://localhost:3200/ready');
      return { ok: r.ok, detail: r.ok ? 'Ready' : 'Not ready' };
    }),
    check('Tempo OTLP port listening', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'ss -tlnp | grep 4318');
      return { ok: r.ok && r.stdout.includes('4318'), detail: r.ok ? 'Listening' : 'Not listening' };
    }),
    check('Prometheus OTLP enabled', 'vps2', async () => {
      const r = await sshSafe(
        cfg,
        'vps2',
        'curl -sf http://10.0.0.2:9090/api/v1/status/config | grep -o enable_otlp_receiver'
      );
      return { ok: r.ok && r.stdout.includes('enable_otlp_receiver'), detail: r.ok ? 'Enabled' : 'Not enabled' };
    }),
    check('Traces endpoint reachable', 'vps1', async () => {
      const r = await sshSafe(
        cfg,
        'vps1',
        'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:4318/v1/traces'
      );
      const code = r.stdout.trim();
      return { ok: r.ok && code !== '000', detail: `HTTP ${code}` };
    }),
    check('Metrics OTLP endpoint reachable', 'vps1', async () => {
      const r = await sshSafe(
        cfg,
        'vps1',
        'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:9090/api/v1/otlp/v1/metrics'
      );
      const code = r.stdout.trim();
      return { ok: r.ok && code !== '000', detail: `HTTP ${code}` };
    }),
    check('Logs OTLP endpoint reachable', 'vps1', async () => {
      const r = await sshSafe(
        cfg,
        'vps1',
        'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:3100/otlp/v1/logs'
      );
      const code = r.stdout.trim();
      return { ok: r.ok && code !== '000', detail: `HTTP ${code}` };
    }),
  ]);

  // 7.5 Log shipping
  const logChecks = await Promise.all([
    check('Loki receiving logs from VPS-1', 'vps2', async () => {
      const r = await sshSafe(
        cfg,
        'vps2',
        `curl -sf "http://10.0.0.2:3100/loki/api/v1/query" --data-urlencode 'query={host="openclaw"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['data']['result']))" 2>/dev/null`
      );
      const count = parseInt(r.stdout.trim(), 10);
      return { ok: r.ok && count > 0, detail: `${count || 0} stream(s) found` };
    }),
  ]);

  // 7.6 External access
  const networkingChecks = await Promise.all([
    check('Cloudflared service', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active cloudflared 2>/dev/null');
      const active = r.ok && r.stdout.trim() === 'active';
      // Fall back to checking Docker if systemd service doesn't exist
      if (!active) {
        const d = await sshSafe(cfg, 'vps1', 'sudo docker ps --filter name=cloudflared --format "{{.Status}}" 2>/dev/null');
        if (d.ok && d.stdout.includes('Up')) return { ok: true, detail: 'Running (Docker)' };
      }
      return { ok: active, detail: active ? 'Active' : 'Not running' };
    }),
  ]);

  // 7.7 Security
  const secChecks = await Promise.all([
    check('UFW active', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo ufw status | head -1');
      const active = r.ok && r.stdout.includes('active');
      return { ok: active, detail: active ? 'Active' : r.stdout.trim() };
    }),
    check('UFW active', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'sudo ufw status | head -1');
      const active = r.ok && r.stdout.includes('active');
      return { ok: active, detail: active ? 'Active' : r.stdout.trim() };
    }),
    check('Fail2ban running', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active fail2ban');
      return { ok: r.ok && r.stdout.trim() === 'active', detail: r.stdout.trim() };
    }),
    check('Fail2ban running', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'sudo systemctl is-active fail2ban');
      return { ok: r.ok && r.stdout.trim() === 'active', detail: r.stdout.trim() };
    }),
    check('SSH on port 222', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'ss -tlnp | grep 222');
      return { ok: r.ok && r.stdout.includes(':222'), detail: r.ok ? 'Listening' : 'Not found' };
    }),
    check('SSH on port 222', 'vps2', async () => {
      const r = await sshSafe(cfg, 'vps2', 'ss -tlnp | grep 222');
      return { ok: r.ok && r.stdout.includes(':222'), detail: r.ok ? 'Listening' : 'Not found' };
    }),
    check('Sysbox runtime', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo systemctl is-active sysbox');
      return { ok: r.ok && r.stdout.trim() === 'active', detail: r.stdout.trim() };
    }),
    check('Backup cron job', 'vps1', async () => {
      const r = await sshSafe(cfg, 'vps1', 'sudo cat /etc/cron.d/openclaw-backup 2>/dev/null | head -1');
      return { ok: r.ok && r.stdout.trim().length > 0, detail: r.ok ? 'Configured' : 'Missing' };
    }),
  ]);

  const all = [
    ...wgChecks,
    ...oclawChecks,
    ...monChecks,
    ...crossChecks,
    ...otelChecks,
    ...logChecks,
    ...networkingChecks,
    ...secChecks,
  ];

  printResults(all);
}
