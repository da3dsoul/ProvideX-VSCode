// pvxprg: file system — presents compiled ProvideX programs ([Pvxprg] files) as editable source text.
// Reading decompiles through the installed ProvideX (LIST); writing compiles (MERGE + SAVE) back to the same file.
import * as vscode from 'vscode';
import * as fs from 'fs';
import { LanguageClient } from 'vscode-languageclient/node';
import { encode1252, decode1252 } from './cp1252';

export const PVXPRG_SCHEME = 'pvxprg';

export function viewMode(): 'readable' | 'typescript' | 'numbered' {
  return vscode.workspace.getConfiguration('providex').get<'readable' | 'typescript' | 'numbered'>('compiledView', 'readable');
}
function readable(): boolean { return viewMode() !== 'numbered'; }

/** pvxprg:/path/X.pvc?ts opens a compiled program as ProvideX/TS regardless of the setting. */
export function wantsTs(uri: vscode.Uri): boolean { return uri.query === 'ts' || (uri.query !== 'pvx' && viewMode() === 'typescript'); }

export function isCompiledProgram(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '[Pvxprg]';
  } catch { return false; }
}

export class CompiledProgramFS implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private cache = new Map<string, { mtime: number; text: Uint8Array; base?: unknown; ts?: boolean }>();
  private confirmed = new Set<string>();

  constructor(private client: LanguageClient, private log: vscode.OutputChannel) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  stat(uri: vscode.Uri): vscode.FileStat {
    const st = fs.statSync(uri.fsPath);
    const cached = this.cache.get(uri.fsPath.toLowerCase());
    return { type: vscode.FileType.File, ctime: st.ctimeMs, mtime: st.mtimeMs, size: cached?.text.byteLength ?? st.size };
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('pvxprg: is file-only'); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const ts = wantsTs(uri);
    const key = uri.fsPath.toLowerCase() + (ts ? '?ts' : '');
    const st = fs.statSync(uri.fsPath);
    const c = this.cache.get(key);
    if (c && c.mtime === st.mtimeMs) return c.text;
    if (ts && isCompiledProgram(uri.fsPath)) {
      const v = await this.client.sendRequest<{ text: string; base: unknown }>('providex/decompilePxts', { path: uri.fsPath });
      const bytes = Buffer.from(v.text.split('\n').join('\r\n'), 'utf8');
      this.cache.set(key, { mtime: st.mtimeMs, text: bytes, base: v.base, ts: true });
      return bytes;
    }
    if (!isCompiledProgram(uri.fsPath)) {
      const raw = fs.readFileSync(uri.fsPath);
      this.cache.set(key, { mtime: st.mtimeMs, text: raw });
      return raw;
    }
    if (readable()) {
      // statement numbers hidden, one statement per line, formatted; numbers are restored on save
      const v = await this.client.sendRequest<{ text: string; base: unknown }>('providex/decompileView', { path: uri.fsPath });
      const bytes = encode1252(v.text.split('\n').join('\r\n') + '\r\n');
      this.cache.set(key, { mtime: st.mtimeMs, text: bytes, base: v.base });
      return bytes;
    }
    const lines = await this.client.sendRequest<string[]>('providex/decompile', { path: uri.fsPath });
    const text = lines.join('\r\n') + '\r\n';
    const bytes = encode1252(text);
    this.cache.set(key, { mtime: st.mtimeMs, text: bytes });
    return bytes;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const ts = wantsTs(uri);
    const key = uri.fsPath.toLowerCase() + (ts ? '?ts' : '');
    if (!this.confirmed.has(key) && vscode.workspace.getConfiguration('providex').get<boolean>('compiled.confirmSave', true)) {
      const ok = await vscode.window.showWarningMessage(
        `Compile and overwrite the program ${uri.fsPath}? A backup is written to ${uri.fsPath}.bak first.`,
        { modal: true }, 'Compile and Save');
      if (ok !== 'Compile and Save') throw vscode.FileSystemError.NoPermissions('Save cancelled');
      this.confirmed.add(key);
    }
    if (fs.existsSync(uri.fsPath) && isCompiledProgram(uri.fsPath)) fs.copyFileSync(uri.fsPath, uri.fsPath + '.bak');
    const cached = this.cache.get(key);
    const text = (ts ? Buffer.from(content).toString('utf8') : decode1252(content)).replace(/\r\n/g, '\n').replace(/\n$/, '');
    const viewMode = cached ? cached.base !== undefined : readable();
    const r = ts
      ? await this.client.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null; saved: boolean; base?: unknown; renumbered?: number }>('providex/compilePxts', { text, out: uri.fsPath, base: cached?.base })
      : viewMode
      ? await this.client.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null; saved: boolean; base?: unknown; renumbered?: number }>('providex/compileView', { text, out: uri.fsPath, base: cached?.base })
      : await this.client.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null; saved: boolean; base?: unknown; renumbered?: number }>('providex/compile', { text, out: uri.fsPath });
    if (r.mergeError) throw vscode.FileSystemError.Unavailable('ProvideX: ' + r.mergeError);
    if (!r.saved) {
      const lines = r.diagnostics.slice(0, 5).map((d) => d.line + 1).join(', ');
      throw vscode.FileSystemError.Unavailable(`ProvideX: program not saved — syntax errors at line(s) ${lines}`);
    }
    this.log.appendLine(`Compiled ${uri.fsPath}${r.renumbered ? ` (${r.renumbered} statement(s) renumbered to make room)` : ''}`);
    const st = fs.statSync(uri.fsPath);
    this.cache.set(key, { mtime: st.mtimeMs, text: content, base: viewMode || ts ? r.base : undefined, ts });
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): void { throw vscode.FileSystemError.NoPermissions('Delete compiled programs from the Explorer'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Rename compiled programs from the Explorer'); }
}
