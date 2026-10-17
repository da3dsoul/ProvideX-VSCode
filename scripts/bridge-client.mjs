// Minimal Node client for bridge/pvxbridge.ps1 (used by build scripts).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE = path.join(here, '..', 'bridge', 'pvxbridge.ps1');

export function openBridge(home) {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rl = createInterface({ input: ps.stdout });
  const pending = new Map();
  let nextId = 1;
  let readyResolve;
  const started = new Promise((r) => (readyResolve = r));
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === 0) { readyResolve(); return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
  });
  function send(cmd, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ps.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }
  const ready = started.then(() => send('init', { home }));
  return {
    ready,
    async call(cmd, args = {}) {
      await ready;
      return send(cmd, args);
    },
    close() { ps.stdin.end(); },
  };
}
