// Client for bridge/pvxbridge.ps1 which drives the installed ProvideX through its ProvideX.Script COM server.
import { ChildProcessWithoutNullStreams, spawn, execFile } from 'child_process';
import * as readline from 'readline';

export interface BridgeDiagnostic { line: number; stmt: number; code: number; message: string; text: string }
export interface CheckResult { diagnostics: BridgeDiagnostic[]; mergeError: string | null; canonical: { n: number; line: number; text: string }[] }
export interface CompileResult { diagnostics: BridgeDiagnostic[]; mergeError: string | null; saved: boolean }
export interface InitInfo { lwd: string; serverPid?: number; development: boolean; licenceError?: number | null; licenceMessage?: string | null }
export interface ListResult { lines: { n: number; bad: boolean; text: string }[] }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class ProvideXBridge {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private serverPid?: number;
  public initInfo?: InitInfo;
  public lastError?: string;

  constructor(private scriptPath: string, private home: () => string, private log: (s: string) => void) {}

  get running(): boolean { return !!this.proc && !this.proc.killed; }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { windowsHide: true });
      this.proc = p;
      const rl = readline.createInterface({ input: p.stdout });
      let ready = false;
      rl.on('line', (line) => {
        let msg: { id: number; ok: boolean; result?: unknown; error?: string };
        try { msg = JSON.parse(line); } catch { this.log('bridge: ' + line); return; }
        if (msg.id === 0 && !ready) {
          ready = true;
          this.send<InitInfo>('init', { home: this.home() }, 30000).then((r) => { this.serverPid = r?.serverPid ?? undefined; this.initInfo = r; resolve(); }, (e) => reject(e));
          return;
        }
        const pend = this.pending.get(msg.id);
        if (!pend) return;
        this.pending.delete(msg.id);
        clearTimeout(pend.timer);
        if (msg.ok) pend.resolve(msg.result);
        else pend.reject(new Error(msg.error ?? 'ProvideX bridge error'));
      });
      p.stderr.on('data', (d) => this.log('bridge stderr: ' + String(d)));
      p.on('exit', (code) => {
        this.log(`ProvideX bridge exited (${code})`);
        for (const [, pend] of this.pending) { clearTimeout(pend.timer); pend.reject(new Error('ProvideX bridge exited')); }
        this.pending.clear();
        this.proc = undefined;
        this.starting = undefined;
        if (!ready) reject(new Error('ProvideX bridge failed to start'));
      });
      p.on('error', (e) => { this.lastError = e.message; reject(e); });
    });
    this.starting.catch((e) => { this.lastError = String(e?.message ?? e); this.starting = undefined; });
    return this.starting;
  }

  private send<T>(cmd: string, args: unknown, timeoutMs = 60000): Promise<T> {
    const p = this.proc;
    if (!p) return Promise.reject(new Error('ProvideX bridge not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ProvideX bridge timed out on ${cmd}`));
        this.restart();
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    });
  }

  /** Requests are serialized: ProvideX has a single program workspace per COM instance. */
  call<T>(cmd: string, args: unknown = {}, timeoutMs?: number): Promise<T> {
    const run = async () => {
      await this.start();
      try {
        return await this.send<T>(cmd, args, timeoutMs);
      } catch (e) {
        const m = String((e as Error).message);
        if (/RPC server is unavailable|Init must first be called|bridge exited|bridge not running/.test(m)) {
          // pvxcom.exe died or is wedged: restart once
          this.restart();
          await this.start();
          return await this.send<T>(cmd, args, timeoutMs);
        }
        throw e;
      }
    };
    const r = this.queue.then(run, run);
    this.queue = r.catch(() => undefined);
    return r;
  }

  /** Starts the bridge (if needed) and returns what ProvideX reported at init, including the licence probe. */
  async info(): Promise<InitInfo> {
    await this.start();
    return this.initInfo!;
  }

  check(text: string, canonical = false) { return this.call<CheckResult>('check', { text, canonical }); }
  compile(text: string, out: string, force = false) { return this.call<CompileResult>('compile', { text, out, force }); }
  list(path: string, noLet = false) { return this.call<ListResult>('list', { path, noLet }); }
  evaluate(expr: string) { return this.call<string>('eval', { expr }); }

  /** Stops the bridge: graceful (stdin EOF lets it release pvxcom.exe), then forced after a grace period. */
  restart() {
    const p = this.proc;
    const pid = this.serverPid;
    this.proc = undefined;
    this.starting = undefined;
    this.serverPid = undefined;
    if (!p) return;
    try { p.stdin.end(); } catch { /* ignore */ }
    const t = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
      // the COM server outlives a killed client; terminate the instance this bridge created
      if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
    }, 3000);
    p.once('exit', () => clearTimeout(t));
  }

  dispose() {
    this.restart();
  }

  /** Synchronous teardown for process exit: no time for a graceful shutdown. */
  killNow() {
    const pid = this.serverPid;
    try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* ignore */ }
    if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  }
}

/** Is the ProvideX.Script COM class registered on this machine? */
export function comServerRegistered(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCR\\ProvideX.Script\\CLSID'], { windowsHide: true }, (err) => resolve(!err));
  });
}
