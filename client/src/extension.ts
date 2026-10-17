// VS Code extension entry point for Sage ProvideX.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';
import { detectHome, detectHomes } from './home';
import { encode1252 } from './cp1252';
import { CompiledProgramFS, PVXPRG_SCHEME, isCompiledProgram, wantsTs } from './compiledFs';

let client: LanguageClient | undefined;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let extContext: vscode.ExtensionContext;

/** What the language server found when it probed the ProvideX installs. */
interface LicenceState {
  state: 'ok' | 'fallback' | 'runtime' | 'unavailable' | 'disabled';
  home?: string;
  preferred?: string;
  configured?: string;
  checked: { home: string; development: boolean; error?: string }[];
}
let licence: LicenceState | undefined;

function config() { return vscode.workspace.getConfiguration('providex'); }

export function resolveHome(): string | undefined {
  const configured = config().get<string>('home');
  if (configured) return configured;
  const hints = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file' || active?.scheme === PVXPRG_SCHEME) hints.unshift(path.dirname(active.fsPath));
  return detectHome(hints);
}

function hintPaths(): string[] {
  const hints = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file' || active?.scheme === PVXPRG_SCHEME) hints.unshift(path.dirname(active.fsPath));
  return hints;
}

export async function activate(context: vscode.ExtensionContext) {
  extContext = context;
  output = vscode.window.createOutputChannel('ProvideX');
  const home = resolveHome();
  output.appendLine(`ProvideX home: ${home ?? '(not found — set providex.home)'}`);

  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6011'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: 'providex', scheme: 'file' }, { language: 'providex', scheme: PVXPRG_SCHEME }, { language: 'providex', scheme: 'untitled' },
      { language: 'pxts', scheme: 'file' }, { language: 'pxts', scheme: PVXPRG_SCHEME }, { language: 'pxts', scheme: 'untitled' },
    ],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{pvx,pvt,pvxsrc,bbx,pxs,txt,pxts}') },
    initializationOptions: { bridgeScript: context.asAbsolutePath(path.join('bridge', 'pvxbridge.ps1')), detectedHome: home ?? '', candidateHomes: detectHomes(hintPaths()) },
    outputChannel: output,
  };
  client = new LanguageClient('providex', 'ProvideX Language Server', serverOptions, clientOptions);
  client.onNotification('providex/licence', (l: LicenceState) => { licence = l; updateStatus(); void reportLicence(l); });
  await client.start();

  // compiled programs (pvxprg:) are decompiled on read and compiled on write
  const cfs = new CompiledProgramFS(client, output);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(PVXPRG_SCHEME, cfs, { isCaseSensitive: false }));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('providex.compiledProgram', new CompiledRedirectEditor(), { supportsMultipleEditorsPerDocument: false }));

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'providex.showStatus';
  context.subscriptions.push(status);
  updateStatus();

  const reg = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('providex.openCompiled', async (uri?: vscode.Uri) => {
    uri ??= (await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Open compiled ProvideX program' }))?.[0];
    if (!uri) return;
    await openCompiled(uri);
  });

  reg('providex.decompileToFile', async (uri?: vscode.Uri) => {
    uri ??= (await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Decompile ProvideX program' }))?.[0];
    if (!uri) return;
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(uri.fsPath.replace(/(\.[^.\\/]*)?$/, '.pvx')), filters: { 'ProvideX source': ['pvx', 'txt'] } });
    if (!target) return;
    try {
      const lines = await client!.sendRequest<string[]>('providex/decompile', { path: uri.fsPath });
      const text = lines.join('\r\n') + '\r\n';
      await vscode.workspace.fs.writeFile(target, encode1252(text));
      await vscode.window.showTextDocument(target);
    } catch (e) { vscode.window.showErrorMessage('Decompile failed: ' + (e as Error).message); }
  });

  reg('providex.compile', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || (ed.document.languageId !== 'providex' && ed.document.languageId !== 'pxts')) return;
    if (ed.document.uri.scheme === PVXPRG_SCHEME) { await ed.document.save(); return; }
    await compileDocument(ed.document, true);
  });

  reg('providex.checkSyntax', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    try {
      const r = await client!.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null }>('providex/check', { text: ed.document.getText() });
      if (r.mergeError) vscode.window.showErrorMessage('ProvideX: ' + r.mergeError);
      else if (!r.diagnostics.length) vscode.window.showInformationMessage('ProvideX: no syntax errors.');
      else {
        vscode.window.showWarningMessage(`ProvideX: ${r.diagnostics.length} statement(s) with syntax errors.`);
        const first = r.diagnostics[0];
        ed.selection = new vscode.Selection(first.line, 0, first.line, 0);
        ed.revealRange(new vscode.Range(first.line, 0, first.line, 0), vscode.TextEditorRevealType.InCenter);
      }
    } catch (e) { vscode.window.showErrorMessage('ProvideX check failed: ' + (e as Error).message); }
  });

  reg('providex.run', async (uri?: vscode.Uri) => runProgram(uri));

  reg('providex.evaluate', async () => {
    const sel = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection);
    const expr = await vscode.window.showInputBox({ prompt: 'ProvideX expression to evaluate', value: sel || '', placeHolder: 'e.g. DTE(0:"%Mz/%Dz/%Y")' });
    if (!expr) return;
    try {
      const r = await client!.sendRequest<string>('providex/evaluate', { expr });
      output.appendLine(`> ${expr}\n${r}`);
      vscode.window.showInformationMessage(`${expr} = ${r}`);
    } catch (e) { vscode.window.showErrorMessage((e as Error).message); }
  });

  reg('providex.renumber', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const v = await vscode.window.showInputBox({ prompt: 'Renumber: start,step', value: '10,10' });
    if (!v) return;
    const [start, step] = v.split(',').map((s) => parseInt(s.trim(), 10));
    await applyServerEdits(ed, 'providex/renumber', { uri: ed.document.uri.toString(), start: start || 10, step: step || 10 });
  });

  reg('providex.toggleLineNumbers', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const numbered = /^\s*\d+\s/.test(ed.document.lineAt(firstCodeLine(ed.document)).text);
    if (numbered) await applyServerEdits(ed, 'providex/stripLineNumbers', { uri: ed.document.uri.toString() });
    else await applyServerEdits(ed, 'providex/renumber', { uri: ed.document.uri.toString(), start: 10, step: 10 });
  });

  // raw LIST of a compiled program (used by tests / scripting)
  reg('providex.debugDecompile', (p: string) => client!.sendRequest<string[]>('providex/decompile', { path: p }));

  reg('providex.openCompiledAsPxts', async (uri?: vscode.Uri) => {
    uri ??= (await vscode.window.showOpenDialog({ canSelectMany: false, title: 'Open compiled ProvideX program as ProvideX/TS' }))?.[0];
    if (uri) await openCompiled(uri, 'ts');
  });

  reg('providex.convertToPxts', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'providex') return;
    const text = await client!.sendRequest<string>('providex/toPxts', { text: ed.document.getText() });
    const target = ed.document.uri.scheme === 'file' ? vscode.Uri.file(ed.document.uri.fsPath.replace(/\.[^.\\/]*$/, '') + '.pxts') : undefined;
    if (target && !fs.existsSync(target.fsPath)) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
      await vscode.window.showTextDocument(target);
    } else {
      const doc = await vscode.workspace.openTextDocument({ language: 'pxts', content: text });
      await vscode.window.showTextDocument(doc);
    }
  });

  reg('providex.convertFromPxts', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'pxts') return;
    const r0 = await client!.sendRequest<{ text: string; problems: { line: number; message: string; severity?: string }[] }>('providex/fromPxts', { text: ed.document.getText() });
    const r = { ...r0, problems: r0.problems.filter((x) => x.severity !== 'warning') };
    if (r.problems.length) { vscode.window.showErrorMessage(`ProvideX/TS: ${r.problems.length} problem(s), first at line ${r.problems[0].line + 1}: ${r.problems[0].message}`); return; }
    const doc = await vscode.workspace.openTextDocument({ language: 'providex', content: r.text + '\n' });
    await vscode.window.showTextDocument(doc);
  });

  reg('providex.makeReadable', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.languageId !== 'providex') return;
    const text = await client!.sendRequest<string | null>('providex/makeReadable', { uri: ed.document.uri.toString() });
    if (text == null) return;
    const eol = ed.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    await ed.edit((b) => b.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), text.split('\n').join(eol) + eol));
  });

  reg('providex.restartServer', async () => { await client?.restart(); updateStatus(); });

  reg('providex.showStatus', async () => {
    const s = await client?.sendRequest<{ bridge: boolean; home: string; development: boolean; files: number; lastError?: string }>('providex/status');
    const items: { label: string; description?: string; action: string }[] = [
      { label: `$(home) ProvideX: ${s?.home || '(none found)'}`, description: s?.bridge ? (s.development ? 'development licence' : 'runtime licence only') : 'not connected', action: 'choose' },
    ];
    for (const c of licence?.checked ?? []) {
      if (c.home === s?.home) continue;
      items.push({ label: `$(circle-outline) ${c.home}`, description: c.error ? 'failed to start' : c.development ? 'development licence' : 'runtime licence only', action: 'use:' + c.home });
    }
    items.push(
      { label: '$(folder-opened) Choose ProvideX folder…', action: 'choose' },
      { label: '$(refresh) Re-check ProvideX installs', action: 'bridge' },
      { label: `$(files) Indexed source files: ${s?.files ?? 0}`, action: '' },
      { label: '$(gear) Open ProvideX settings', action: 'settings' },
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'ProvideX' });
    if (!pick) return;
    if (pick.action === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'providex');
    else if (pick.action === 'choose') await chooseHome();
    else if (pick.action.startsWith('use:')) await setHome(pick.action.slice(4));
    else if (pick.action === 'bridge') await client?.sendRequest('providex/restartBridge');
  });
  reg('providex.chooseHome', () => chooseHome());

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (d) => {
    if ((d.languageId === 'providex' || d.languageId === 'pxts') && d.uri.scheme === 'file' && config().get<boolean>('compile.onSave')) await compileDocument(d, false);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('providex')) updateStatus(); }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateStatus()));
}

function firstCodeLine(doc: vscode.TextDocument): number {
  for (let i = 0; i < doc.lineCount; i++) if (doc.lineAt(i).text.trim()) return i;
  return 0;
}

async function applyServerEdits(ed: vscode.TextEditor, method: string, params: unknown) {
  const edits = await client!.sendRequest<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]>(method, params);
  const we = new vscode.WorkspaceEdit();
  for (const e of edits) we.replace(ed.document.uri, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
  await vscode.workspace.applyEdit(we);
}

function updateStatus() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || (ed.document.languageId !== 'providex' && ed.document.languageId !== 'pxts')) { status.hide(); return; }
  const l = licence;
  if (!l) {
    status.text = '$(sync~spin) ProvideX';
    status.tooltip = 'Checking ProvideX installs…';
  } else if (l.state === 'ok' || l.state === 'fallback') {
    status.text = '$(check) ProvideX';
    status.tooltip = `ProvideX (development licence): ${l.home}`;
  } else if (l.state === 'runtime') {
    status.text = '$(warning) ProvideX: runtime licence';
    status.tooltip = `${l.home} has a runtime-only activation: decompiling, compiling and ProvideX syntax checks are unavailable. Click for options.`;
  } else {
    status.text = '$(circle-slash) ProvideX';
    status.tooltip = l.state === 'disabled' ? 'ProvideX integration is disabled or no ProvideX was found' : 'ProvideX could not be started';
  }
  status.show();
}

async function setHome(home: string) {
  await config().update('home', home, vscode.ConfigurationTarget.Global);
  await client?.sendRequest('providex/restartBridge');
}

async function chooseHome() {
  const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Select the ProvideX home folder (contains pvxwin32.exe and Lib)' });
  if (!pick?.[0]) return;
  const dir = pick[0].fsPath;
  if (!fs.existsSync(path.join(dir, 'pvxwin32.exe'))) {
    vscode.window.showErrorMessage(`${dir} does not contain pvxwin32.exe. Select the ProvideX Home folder (for Sage 100: ...\\MAS90\\Home).`);
    return;
  }
  await setHome(dir);
}

/** Tells the user, once per situation, which ProvideX is in use and what a runtime licence means. */
async function reportLicence(l: LicenceState) {
  const key = 'providex.licenceNotice:' + l.state + ':' + (l.home ?? '');
  for (const c of l.checked) output.appendLine(`ProvideX at ${c.home}: ${c.error ? 'failed to start (' + c.error + ')' : c.development ? 'development licence' : 'runtime licence only'}`);
  if (l.state === 'ok' || l.state === 'disabled') return;
  if (extContext.globalState.get<boolean>(key)) return;
  if (l.state === 'fallback') {
    const which = l.configured ? 'The configured ProvideX' : 'The ProvideX nearest this workspace';
    const choice = await vscode.window.showInformationMessage(
      `${which} (${l.preferred}) has a runtime-only licence, so decompiling and compiling use the development-licensed ProvideX at ${l.home}.`,
      'Make Permanent', "Don't Show Again");
    if (choice === 'Make Permanent' && l.home) await setHome(l.home);
    if (choice === "Don't Show Again") await extContext.globalState.update(key, true);
    return;
  }
  if (l.state === 'runtime') {
    const choice = await vscode.window.showWarningMessage(
      `ProvideX at ${l.home} has a runtime (end-user) licence. ProvideX refuses to list or edit programs without a development licence (Error #61 "Authorization failure"), so decompiling, compiling and ProvideX syntax checks are unavailable. Highlighting, completion, navigation and the built-in checks still work.`,
      { detail: 'Point the extension at a ProvideX activated for development, or activate this install for development with Sage (pvxwactv.exe in the ProvideX Home folder).' } as vscode.MessageOptions,
      'Choose ProvideX Folder…', 'Learn More', "Don't Show Again");
    if (choice === 'Choose ProvideX Folder…') await chooseHome();
    if (choice === 'Learn More') vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(extContext.asAbsolutePath('README.md')));
    if (choice === "Don't Show Again") await extContext.globalState.update(key, true);
    return;
  }
  vscode.window.showWarningMessage('ProvideX could not be started: ' + (l.checked.map((c) => c.error).filter(Boolean)[0] ?? 'unknown error') + '. Check providex.home.', 'Choose ProvideX Folder…')
    .then((c) => { if (c) void chooseHome(); });
}

export async function openCompiled(uri: vscode.Uri, as?: 'ts' | 'pvx') {
  const target = uri.with({ scheme: PVXPRG_SCHEME, query: as ?? '' });
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.languages.setTextDocumentLanguage(doc, wantsTs(target) ? 'pxts' : 'providex');
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function compileDocument(doc: vscode.TextDocument, interactive: boolean): Promise<string | undefined> {
  const ext = config().get<string>('compile.outputExtension', '.pvc');
  const out = doc.uri.fsPath.replace(/\.[^.\\/]*$/, '') + ext;
  try {
    const r = doc.languageId === 'pxts'
      ? await client!.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null; saved: boolean }>('providex/compilePxts', { text: doc.getText(), out })
      : await client!.sendRequest<{ diagnostics: { line: number; message: string }[]; mergeError: string | null; saved: boolean }>('providex/compile', { text: doc.getText(), out });
    if (r.mergeError) { vscode.window.showErrorMessage('ProvideX: ' + r.mergeError); return undefined; }
    if (!r.saved) {
      vscode.window.showErrorMessage(`ProvideX: not compiled — ${r.diagnostics.length} statement(s) with syntax errors (first at line ${r.diagnostics[0].line + 1}).`);
      return undefined;
    }
    if (interactive) vscode.window.setStatusBarMessage(`$(check) Compiled ${path.basename(out)}`, 4000);
    return out;
  } catch (e) {
    vscode.window.showErrorMessage('ProvideX compile failed: ' + (e as Error).message);
    return undefined;
  }
}

async function runProgram(uri?: vscode.Uri) {
  const ed = vscode.window.activeTextEditor;
  const home = resolveHome();
  if (!home) { vscode.window.showErrorMessage('ProvideX installation not found — set providex.home.'); return; }
  const exe = config().get<string>('executable') || path.join(home, 'pvxwin32.exe');
  let program: string | undefined;
  if (uri && uri.scheme === 'file' && isCompiledProgram(uri.fsPath)) program = uri.fsPath;
  else if (ed && (ed.document.uri.scheme === PVXPRG_SCHEME)) { if (ed.document.isDirty) await ed.document.save(); program = ed.document.uri.fsPath; }
  else if (ed && (ed.document.languageId === 'providex' || ed.document.languageId === 'pxts')) {
    // compile the text source to a temporary program and run that
    const tmp = path.join(os.tmpdir(), 'providex-run', path.basename(ed.document.uri.fsPath).replace(/\.[^.]*$/, '') + '.pvc');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const r = await client!.sendRequest<{ saved: boolean; diagnostics: unknown[]; mergeError: string | null }>(ed.document.languageId === 'pxts' ? 'providex/compilePxts' : 'providex/compile', { text: ed.document.getText(), out: tmp });
    if (!r.saved) { vscode.window.showErrorMessage('ProvideX: program has syntax errors; not run.'); return; }
    program = tmp;
  }
  if (!program) return;
  const progArgs = config().get<string[]>('programArguments', []);
  const args = [...config().get<string[]>('runArguments', []), program, ...(progArgs.length ? ['-ARG', ...progArgs] : [])];
  output.appendLine(`Running: "${exe}" ${args.map((x) => (/s/.test(x) ? `"${x}"` : x)).join(' ')}`);
  // pvxwin32 is a GUI application: start it detached and report its exit code
  const child = cp.spawn(exe, args, { cwd: home, detached: true, stdio: 'ignore' });
  child.on('error', (err) => vscode.window.showErrorMessage('Could not start ProvideX: ' + err.message));
  child.on('exit', (code) => output.appendLine(`ProvideX exited with code ${code}`));
  child.unref();
}

/** Custom editor for *.pvc etc.: immediately reopens the file through the pvxprg: file system as text. */
class CompiledRedirectEditor implements vscode.CustomReadonlyEditorProvider {
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument { return { uri, dispose() { /* nothing */ } }; }
  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.html = `<html><body style="font-family:var(--vscode-font-family);padding:1em">Opening <b>${escapeHtml(path.basename(document.uri.fsPath))}</b> as ProvideX source…</body></html>`;
    if (document.uri.scheme !== 'file' || !isCompiledProgram(document.uri.fsPath)) {
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      panel.dispose();
      return;
    }
    try {
      await openCompiled(document.uri);
      panel.dispose();
    } catch (e) {
      panel.webview.html = `<html><body style="font-family:var(--vscode-font-family);padding:1em">Could not decompile <b>${escapeHtml(document.uri.fsPath)}</b>:<pre>${escapeHtml((e as Error).message)}</pre>Check the <code>providex.home</code> setting.</body></html>`;
    }
  }
}

function escapeHtml(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }

export async function deactivate() {
  await client?.stop();
}
