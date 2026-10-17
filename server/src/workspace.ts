// Workspace-wide index of ProvideX sources: classes (DEF CLASS), labels/entry points, DEF FN functions.
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { parse, ParsedDoc, ClassDef, ClassMember } from './parser';

export interface IndexedFile {
  uri: string;
  fsPath: string;
  doc: ParsedDoc;
  mtime: number;
  /** decompiled from a compiled program (via the bridge) */
  compiled?: boolean;
}

export const SOURCE_EXTS = ['.pvx', '.pvt', '.pvxsrc', '.bbx', '.pxs', '.txt', '.pxts'];
/** set by the server: translates .pxts sources to ProvideX for indexing */
export const translators: { pxts?: (text: string, fsPath: string) => string } = {};

export class WorkspaceIndex {
  private files = new Map<string, IndexedFile>(); // key: lower-case fsPath
  private classMap = new Map<string, { file: IndexedFile; cls: ClassDef }>();
  public folders: string[] = [];
  /** directories searched for compiled class programs (e.g. Sage 100 module folders) */
  public classPath: string[] = [];
  /** resolves compiled programs to source text (through the bridge); undefined when unavailable */
  public decompile?: (fsPath: string) => Promise<string | undefined>;
  private pendingCompiled = new Map<string, Promise<IndexedFile | undefined>>();

  setFolders(folders: string[]) { this.folders = folders; }

  scan(maxFiles = 20000): number {
    let count = 0;
    const visit = (dir: string, depth: number) => {
      if (depth > 12 || count >= maxFiles) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visit(p, depth + 1);
        else if (isSourceFile(p)) { this.indexFile(p); count++; }
      }
    };
    for (const f of this.folders) visit(f, 0);
    return count;
  }

  indexFile(fsPath: string, text?: string): IndexedFile | undefined {
    try {
      const st = fs.statSync(fsPath);
      const key = fsPath.toLowerCase();
      const prev = this.files.get(key);
      if (!text && prev && prev.mtime === st.mtimeMs) return prev;
      if (text === undefined) {
        if (st.size > 8 * 1024 * 1024) return undefined;
        const buf = fs.readFileSync(fsPath);
        if (buf.subarray(0, 8).toString('latin1') === '[Pvxprg]') return undefined;
        text = buf.toString('latin1');
        if (path.extname(fsPath).toLowerCase() === '.txt' && !looksLikeProvideX(text)) return undefined;
        if (path.extname(fsPath).toLowerCase() === '.pxts') { if (!translators.pxts) return undefined; text = translators.pxts(buf.toString('utf8'), fsPath); }
      }
      return this.put(fsPath, text, st.mtimeMs);
    } catch { return undefined; }
  }

  /** Update from an open editor buffer. */
  update(uri: string, doc: ParsedDoc) {
    const fsPath = uriToPath(uri);
    if (!fsPath) return;
    this.removeClasses(fsPath.toLowerCase());
    const f: IndexedFile = { uri, fsPath, doc, mtime: Date.now() };
    this.files.set(fsPath.toLowerCase(), f);
    this.addClasses(f);
  }

  remove(fsPath: string) {
    const key = fsPath.toLowerCase();
    this.removeClasses(key);
    this.files.delete(key);
  }

  private put(fsPath: string, text: string, mtime: number, compiled = false): IndexedFile {
    const key = fsPath.toLowerCase();
    this.removeClasses(key);
    const f: IndexedFile = { uri: URI.file(fsPath).toString(), fsPath, doc: parse(text), mtime, compiled };
    this.files.set(key, f);
    this.addClasses(f);
    return f;
  }

  private addClasses(f: IndexedFile) {
    for (const cls of f.doc.classes) this.classMap.set(cls.name.toUpperCase(), { file: f, cls });
  }
  private removeClasses(key: string) {
    for (const [k, v] of this.classMap) if (v.file.fsPath.toLowerCase() === key) this.classMap.delete(k);
  }

  allFiles(): IndexedFile[] { return [...this.files.values()]; }
  getFile(fsPath: string): IndexedFile | undefined { return this.files.get(fsPath.toLowerCase()); }

  findClass(name: string): { file: IndexedFile; cls: ClassDef } | undefined {
    return this.classMap.get(name.toUpperCase());
  }

  /** Looks up a class, decompiling it from the class path if necessary. */
  async resolveClass(name: string): Promise<{ file: IndexedFile; cls: ClassDef } | undefined> {
    const hit = this.findClass(name);
    if (hit) return hit;
    if (!this.decompile) return undefined;
    const file = this.locateProgram(name, ['.pvc', '.PVC', '.pvo', '']);
    if (!file) return undefined;
    const key = file.toLowerCase();
    let p = this.pendingCompiled.get(key);
    if (!p) {
      p = (async () => {
        const text = await this.decompile!(file).catch(() => undefined);
        if (!text) return undefined;
        return this.put(file, text, fs.statSync(file).mtimeMs, true);
      })();
      this.pendingCompiled.set(key, p);
    }
    await p;
    return this.findClass(name);
  }

  /** All members of a class including inherited (LIKE) ones; nearest definition wins. */
  async classMembers(name: string, seen = new Set<string>()): Promise<{ member: ClassMember; owner: ClassDef; file: IndexedFile }[]> {
    const key = name.toUpperCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const hit = await this.resolveClass(name);
    if (!hit) return [];
    const out = hit.cls.members.map((m) => ({ member: m, owner: hit.cls, file: hit.file }));
    const names = new Set(out.map((o) => o.member.name.toUpperCase() + ':' + o.member.kind));
    for (const parent of hit.cls.likes) {
      for (const pm of await this.classMembers(parent, seen)) {
        const k = pm.member.name.toUpperCase() + ':' + pm.member.kind;
        if (!names.has(k) && !pm.member.local) { names.add(k); out.push(pm); }
      }
    }
    return out;
  }

  /** Finds a program file by ProvideX name in workspace folders and the class path. */
  locateProgram(name: string, exts: string[] = ['', '.pvx', '.pvc', '.PVC', '.pvt', '.txt']): string | undefined {
    const clean = name.replace(/^\*+/, '').replace(/\//g, path.sep);
    if (path.isAbsolute(clean)) {
      for (const e of exts) if (fs.existsSync(clean + e) && fs.statSync(clean + e).isFile()) return clean + e;
    }
    for (const f of this.files.values()) {
      const base = path.basename(f.fsPath);
      const stem = base.replace(/\.[^.]*$/, '');
      if (base.toLowerCase() === clean.toLowerCase() || stem.toLowerCase() === clean.toLowerCase()) return f.fsPath;
    }
    for (const dir of [...this.folders, ...this.classPath]) {
      for (const e of exts) {
        const p = path.join(dir, clean + e);
        try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
        // Sage 100 convention: class SY_Session lives in SY\SY_Session.pvc
        const m = /^([A-Za-z]{2})_/.exec(clean);
        if (m) {
          const p2 = path.join(dir, m[1].toUpperCase(), clean + e);
          try { if (fs.statSync(p2).isFile()) return p2; } catch { /* next */ }
        }
      }
    }
    return undefined;
  }
}

export function isSourceFile(p: string): boolean {
  return SOURCE_EXTS.includes(path.extname(p).toLowerCase());
}

function looksLikeProvideX(text: string): boolean {
  const head = text.slice(0, 4000);
  return /^\s*\d{1,5}\s+(REM|!|LET|PRINT|IF|DEF|GOTO|GOSUB|ENTER|OPEN|READ|SETERR|BEGIN|DIM)\b/im.test(head);
}

export function uriToPath(uri: string): string | undefined {
  try {
    const u = URI.parse(uri);
    if (u.scheme === 'file') return u.fsPath;
    if (u.scheme === 'pvxprg') return u.fsPath;
  } catch { /* ignore */ }
  return undefined;
}
