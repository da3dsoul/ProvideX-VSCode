import { pathToFileURL } from 'url';
const fileUri = (p: string) => pathToFileURL(p).href;
// End-to-end tests of the bundled language server (dist/server.js) over stdio.
// Set PVX_HOME to a ProvideX home folder to also exercise the ProvideX COM bridge.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, MessageConnection } from 'vscode-jsonrpc/node';

const root = path.join(__dirname, '..');
const pvxHome = process.env.PVX_HOME ?? '';
let proc: ChildProcess;
let conn: MessageConnection;
const diagnostics = new Map<string, { message: string; source?: string; range: { start: { line: number } } }[]>();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvx-lsp-'));

const SRC = [
  'DEF CLASS "Demo_Widget"',
  'PROPERTY Name$',
  'LOCAL cCount',
  'FUNCTION Greet(who$)GREET',
  'END DEF',
  '',
  'GREET:',
  'ENTER who$',
  'LET msg$="Hello "+who$; cCount++',
  'LET w=NEW("Demo_Widget")',
  "LET x=w'Greet(UCS(msg$))",
  'GOSUB MISSING_LABEL',
  'RETURN 1',
].join('\n');
const uri = fileUri(path.join(tmp, 'demo.pvx'));

beforeAll(async () => {
  fs.writeFileSync(path.join(tmp, 'demo.pvx'), SRC);
  proc = spawn(process.execPath, [path.join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
  conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: never[] }) => diagnostics.set(p.uri, p.diagnostics));
  conn.onRequest('workspace/configuration', () => [{ home: pvxHome, bridge: { enabled: !!pvxHome }, diagnostics: { useProvideX: pvxHome ? 'onSave' : 'off' } }]);
  conn.onRequest('client/registerCapability', () => null);
  conn.onRequest('window/workDoneProgress/create', () => null);
  conn.listen();
  await conn.sendRequest('initialize', {
    processId: process.pid, rootUri: fileUri(tmp), workspaceFolders: [{ uri: fileUri(tmp), name: 'tmp' }],
    capabilities: { workspace: { configuration: true }, textDocument: { semanticTokens: { requests: { full: true } } } },
    initializationOptions: { bridgeScript: path.join(root, 'bridge', 'pvxbridge.ps1'), detectedHome: pvxHome },
  });
  conn.sendNotification('initialized', {});
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'providex', version: 1, text: SRC } });
}, 60000);

afterAll(async () => {
  await conn.sendRequest('shutdown').catch(() => undefined);
  conn.sendNotification('exit');
  await new Promise((r) => setTimeout(r, 1500));
  conn?.dispose(); proc?.kill();
});

const pos = (line: number, character: number) => ({ textDocument: { uri }, position: { line, character } });
const waitFor = async (pred: () => boolean, ms = 30000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)); };

describe('language server', () => {
  it('publishes analyzer diagnostics', async () => {
    await waitFor(() => (diagnostics.get(uri) ?? []).length > 0);
    const d = diagnostics.get(uri)!;
    expect(d.some((x) => /MISSING_LABEL/.test(x.message))).toBe(true);
  });

  it('hovers built-in functions', async () => {
    const h = await conn.sendRequest<{ contents: { value: string } }>('textDocument/hover', pos(10, 17));
    expect(h.contents.value).toMatch(/UCS/);
  });

  it('completes object members from the class definition', async () => {
    const items = await conn.sendRequest<{ label: string }[]>('textDocument/completion', pos(10, 9));
    expect(items.map((i) => i.label)).toContain('Greet');
  });

  it('goes to the method declaration and implementation', async () => {
    const def = await conn.sendRequest<{ range: { start: { line: number } } }[]>('textDocument/definition', pos(10, 10));
    expect(def[0].range.start.line).toBe(3);
    const impl = await conn.sendRequest<{ range: { start: { line: number } } }[]>('textDocument/implementation', pos(10, 10));
    expect(impl[0].range.start.line).toBe(6);
  });

  it('finds label references and renames variables', async () => {
    const refs = await conn.sendRequest<unknown[]>('textDocument/references', { ...pos(6, 1), context: { includeDeclaration: true } });
    expect(refs.length).toBe(2); // GREET: and FUNCTION ... GREET
    const edit = await conn.sendRequest<{ changes: Record<string, unknown[]> }>('textDocument/rename', { ...pos(8, 5), newName: 'greeting' });
    expect(edit.changes[uri].length).toBe(2);
  });

  it('returns document symbols, folding, semantic tokens and signature help', async () => {
    const syms = await conn.sendRequest<{ name: string; children?: { name: string }[] }[]>('textDocument/documentSymbol', { textDocument: { uri } });
    expect(syms.find((s) => s.name === 'Demo_Widget')?.children?.map((c) => c.name)).toEqual(['Name$', 'cCount', 'Greet']);
    const folds = await conn.sendRequest<unknown[]>('textDocument/foldingRange', { textDocument: { uri } });
    expect(folds.length).toBeGreaterThan(0);
    const st = await conn.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
    expect(st.data.length).toBeGreaterThan(20);
    const sig = await conn.sendRequest<{ signatures: { label: string }[] } | null>('textDocument/signatureHelp', pos(10, 16));
    expect(sig?.signatures[0].label).toMatch(/Greet/);
  });

  it('serves ProvideX/TS (.pxts) documents through the ProvideX analysis', async () => {
    const tsUri = fileUri(path.join(tmp, 'demo.pxts'));
    const src = [
      'class Demo_Widget {',        // 0
      '  property Name$;',           // 1
      '  method Greet(who$) GREET;', // 2
      '}',                           // 3
      'function twice(n) {',         // 4
      '  return n * 2',              // 5
      '}',                           // 6
      'GREET:',                      // 7
      'enter who$',                  // 8
      'w = new("Demo_Widget")',      // 9
      'x$ = ucs(who$) + str(twice(3))', // 10
      'y = w.Greet("a")',            // 11
      'gosub NOWHERE',               // 12
      'return 1',                    // 13
    ].join('\n');
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri: tsUri, languageId: 'pxts', version: 1, text: src } });
    await waitFor(() => (diagnostics.get(tsUri) ?? []).length > 0);
    const d = diagnostics.get(tsUri)!.find((x) => /NOWHERE/.test(x.message))!;
    expect(d.range.start.line).toBe(12);
    const h = await conn.sendRequest<{ contents: { value: string } }>('textDocument/hover', { textDocument: { uri: tsUri }, position: { line: 10, character: 6 } });
    expect(h.contents.value).toMatch(/UCS/);
    const def = await conn.sendRequest<{ range: { start: { line: number } } }[]>('textDocument/definition', { textDocument: { uri: tsUri }, position: { line: 10, character: 23 } });
    expect(def[0].range.start.line).toBe(4);
    const impl = await conn.sendRequest<{ range: { start: { line: number } } }[]>('textDocument/implementation', { textDocument: { uri: tsUri }, position: { line: 11, character: 7 } });
    expect(impl[0].range.start.line).toBe(7);
    conn.sendNotification('textDocument/didChange', { textDocument: { uri: tsUri, version: 2 }, contentChanges: [{ text: src.replace('y = w.Greet("a")', 'y = w.') }] });
    const items = await conn.sendRequest<{ label: string }[]>('textDocument/completion', { textDocument: { uri: tsUri }, position: { line: 11, character: 6 } });
    expect(items.map((i) => i.label)).toContain('Greet');
    const st = await conn.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri: tsUri } });
    expect(st.data.length).toBeGreaterThan(20);
    const syms = await conn.sendRequest<{ name: string; range: { start: { line: number } } }[]>('textDocument/documentSymbol', { textDocument: { uri: tsUri } });
    expect(syms.find((s) => s.name === 'Demo_Widget')?.range.start.line).toBe(0);
  });

  it.skipIf(!pvxHome || !fs.existsSync(path.join(pvxHome, 'Lib', '_grid.pvc')))('waits for the ProvideX probe when a program is opened at startup', async () => {
    const p = spawn(process.execPath, [path.join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const c = createMessageConnection(new StreamMessageReader(p.stdout!), new StreamMessageWriter(p.stdin!));
    c.onRequest('workspace/configuration', () => [{ home: pvxHome, bridge: { enabled: true }, diagnostics: { useProvideX: 'off' } }]);
    c.onRequest('client/registerCapability', () => null);
    c.listen();
    await c.sendRequest('initialize', { processId: process.pid, rootUri: null, workspaceFolders: null, capabilities: { workspace: { configuration: true } }, initializationOptions: { bridgeScript: path.join(root, 'bridge', 'pvxbridge.ps1'), detectedHome: pvxHome, candidateHomes: [] } });
    c.sendNotification('initialized', {});
    // no waiting: this used to fail with "needs an installed ProvideX" while the install was still being probed
    const lines = await c.sendRequest<string[]>('providex/decompile', { path: path.join(pvxHome, 'Lib', '_grid.pvc') });
    expect(lines.length).toBeGreaterThan(10);
    await c.sendRequest('shutdown').catch(() => undefined);
    c.sendNotification('exit');
    await new Promise((r) => setTimeout(r, 1500));
    c.dispose(); p.kill();
  }, 120000);

  it.skipIf(!pvxHome || !process.env.PVX_RUNTIME_HOME)('falls back from a runtime-only install and explains it', async () => {
    // a second server whose preferred home is runtime-only
    const p2 = spawn(process.execPath, [path.join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const c2 = createMessageConnection(new StreamMessageReader(p2.stdout!), new StreamMessageWriter(p2.stdin!));
    const notes: { state: string; home: string }[] = [];
    c2.onNotification('providex/licence', (l: { state: string; home: string }) => notes.push(l));
    c2.onRequest('workspace/configuration', () => [{ home: process.env.PVX_RUNTIME_HOME, bridge: { enabled: true }, diagnostics: { useProvideX: 'off' } }]);
    c2.onRequest('client/registerCapability', () => null);
    c2.listen();
    const init = (candidates: string[]) => c2.sendRequest('initialize', { processId: process.pid, rootUri: null, workspaceFolders: null, capabilities: { workspace: { configuration: true } }, initializationOptions: { bridgeScript: path.join(root, 'bridge', 'pvxbridge.ps1'), detectedHome: '', candidateHomes: candidates } });
    await init([process.env.PVX_RUNTIME_HOME!, pvxHome]);
    c2.sendNotification('initialized', {});
    await waitFor(() => notes.length > 0, 60000);
    expect(notes[0].state).toBe('fallback');
    expect(notes[0].home.toLowerCase()).toBe(pvxHome.toLowerCase());
    // with only the runtime install available, operations fail with an explanation
    await c2.sendRequest('shutdown').catch(() => undefined);
    c2.sendNotification('exit');
    c2.dispose();
    const p3 = spawn(process.execPath, [path.join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const c3 = createMessageConnection(new StreamMessageReader(p3.stdout!), new StreamMessageWriter(p3.stdin!));
    const notes3: { state: string }[] = [];
    c3.onNotification('providex/licence', (l: { state: string }) => notes3.push(l));
    c3.onRequest('workspace/configuration', () => [{ home: process.env.PVX_RUNTIME_HOME, bridge: { enabled: true }, diagnostics: { useProvideX: 'off' } }]);
    c3.onRequest('client/registerCapability', () => null);
    c3.listen();
    await c3.sendRequest('initialize', { processId: process.pid, rootUri: null, workspaceFolders: null, capabilities: { workspace: { configuration: true } }, initializationOptions: { bridgeScript: path.join(root, 'bridge', 'pvxbridge.ps1'), detectedHome: '', candidateHomes: [] } });
    c3.sendNotification('initialized', {});
    await waitFor(() => notes3.length > 0, 60000);
    expect(notes3[0].state).toBe('runtime');
    await expect(c3.sendRequest('providex/decompile', { path: 'x.pvc' })).rejects.toThrow(/development licence/);
    await c3.sendRequest('shutdown').catch(() => undefined);
    c3.sendNotification('exit');
    await new Promise((r) => setTimeout(r, 1500));
    c3.dispose(); p2.kill(); p3.kill();
  }, 180000);

  it.skipIf(!pvxHome || !fs.existsSync(path.join(pvxHome, '..', 'SY', 'SY_Maint.pvc')))('completes inherited members of compiled Sage classes', async () => {
    const u = fileUri(path.join(tmp, 'inherit.pvx'));
    const text = ['DEF CLASS "My_Maint"', 'LIKE "SY_Maint"', 'END DEF', "X=_OBJ'"].join('\n');
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri: u, languageId: 'providex', version: 1, text } });
    const items = await conn.sendRequest<{ label: string; detail?: string }[]>('textDocument/completion', { textDocument: { uri: u }, position: { line: 3, character: 7 } });
    const labels = items.map((i) => i.label.toUpperCase());
    expect(labels).toContain('SETKEY');
    expect(labels).toContain('WRITE');
  }, 120000);

  it.skipIf(!pvxHome)('validates with the real ProvideX compiler', async () => {
    const bad = fileUri(path.join(tmp, 'bad.pvx'));
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri: bad, languageId: 'providex', version: 1, text: 'PRINT "ok"\nX=1+\nEND' } });
    await waitFor(() => (diagnostics.get(bad) ?? []).some((d) => d.source === 'ProvideX'), 60000);
    const d = diagnostics.get(bad)!.find((x) => x.source === 'ProvideX')!;
    expect(d.range.start.line).toBe(1);
    const out = path.join(tmp, 'ok.pvc');
    const r = await conn.sendRequest<{ saved: boolean }>('providex/compile', { text: '0010 PRINT "hi"\n0020 END', out });
    expect(r.saved).toBe(true);
    const lines = await conn.sendRequest<string[]>('providex/decompile', { path: out });
    expect(lines).toEqual(['0010 PRINT "hi"', '0020 END ']);
  }, 120000);
});
