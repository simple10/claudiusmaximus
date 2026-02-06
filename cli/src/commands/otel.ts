import { select } from '@inquirer/prompts';
import type { Config } from '../types.ts';
import { sshSafe } from '../ssh.ts';
import { header, info, ok, fail, printOutput } from '../ui.ts';

export async function otelMenu(cfg: Config): Promise<void> {
  while (true) {
    header('OTEL');
    const action = await select({
      message: 'OTEL checks',
      choices: [
        { name: 'Check OTLP endpoints', value: 'endpoints' },
        { name: 'View OTEL env vars', value: 'env' },
        { name: 'View OTEL config', value: 'config' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (action === 'back') return;

    switch (action) {
      case 'endpoints': {
        info('Checking OTLP endpoints from VPS-1...');
        // These endpoints should return 400/415 (not connection refused) = reachable
        const checks = await Promise.allSettled([
          sshSafe(
            cfg,
            'vps1',
            'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:4318/v1/traces'
          ).then((r) => {
            const code = r.stdout.trim();
            const reachable = r.ok && code !== '000';
            reachable
              ? ok(`Traces (Tempo 10.0.0.2:4318): HTTP ${code}`)
              : fail(`Traces (Tempo 10.0.0.2:4318): unreachable`);
          }),
          sshSafe(
            cfg,
            'vps1',
            'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:9090/api/v1/otlp/v1/metrics'
          ).then((r) => {
            const code = r.stdout.trim();
            const reachable = r.ok && code !== '000';
            reachable
              ? ok(`Metrics (Prometheus 10.0.0.2:9090): HTTP ${code}`)
              : fail(`Metrics (Prometheus 10.0.0.2:9090): unreachable`);
          }),
          sshSafe(
            cfg,
            'vps1',
            'curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d "{}" http://10.0.0.2:3100/otlp/v1/logs'
          ).then((r) => {
            const code = r.stdout.trim();
            const reachable = r.ok && code !== '000';
            reachable
              ? ok(`Logs (Loki 10.0.0.2:3100): HTTP ${code}`)
              : fail(`Logs (Loki 10.0.0.2:3100): unreachable`);
          }),
        ]);
        console.log();
        break;
      }
      case 'env': {
        const r = await sshSafe(
          cfg,
          'vps1',
          'sudo docker exec openclaw-gateway env | grep OTEL | sort'
        );
        if (r.ok) {
          printOutput(r.stdout);
        } else {
          fail('Could not read OTEL env vars from gateway container');
          if (r.stderr) printOutput(r.stderr);
        }
        console.log();
        break;
      }
      case 'config': {
        const r = await sshSafe(
          cfg,
          'vps1',
          'sudo cat /home/openclaw/.openclaw/openclaw.json'
        );
        if (r.ok) {
          try {
            const parsed = JSON.parse(r.stdout);
            console.log(JSON.stringify(parsed.diagnostics || parsed, null, 2));
          } catch {
            printOutput(r.stdout);
          }
        } else {
          fail('Could not read openclaw.json');
          if (r.stderr) printOutput(r.stderr);
        }
        console.log();
        break;
      }
    }
  }
}
