// ProvideX language server.
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, InitializeParams, InitializeResult,
  CompletionItem, CompletionItemKind, Diagnostic, DiagnosticSeverity, Hover, Location, Range, Position,
  SignatureHelp, SignatureInformation, ParameterInformation, DocumentSymbol, SymbolKind, WorkspaceSymbol,
  FoldingRange, FoldingRangeKind, SemanticTokensBuilder, SemanticTokensLegend, TextEdit, WorkspaceEdit,
  CodeAction, CodeActionKind, DocumentHighlight, DocumentHighlightKind, DocumentLink, InsertTextFormat,
  CallHierarchyItem, CallHierarchyIncomingCall, CallHierarchyOutgoingCall, CodeLens, DidChangeConfigurationNotification,
  MarkupKind, FileChangeType, DiagnosticTag,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';
import { parse, ParsedDoc, Span, statementAt, tokenAt, ClassMember } from './parser';
import { analyze, nextStatementNumber } from './analyzer';
import { T, Token } from './lexer';
import {
  DIRECTIVES, FUNCTIONS, SYSVARS, MNEMONICS, FILE_OPTIONS, functionDocs, directiveDocs, sysvarDocs, mnemonicDocs, optionDocs,
  specialTargetDocs, systemParams, errorMessages,
} from './lexicon';
import {
  symbolAt, labelDef, lineDef, labelOccurrences, lineOccurrences, varOccurrences, fnOccurrences, memberOccurrences,
  inferObjectClass, leadingComments, trailingComment, enclosingClass, SymbolRef,
} from './symbols';
import {
  functionHover, directiveHover, sysvarHover, mnemonicHover, optionHover, specialHover, paramHover, errorHover, memberHover, md, labelHover,
} from './hover';
import { formatDocumentFull } from './formatter';
import { toView, fromView, ViewResult, ViewOptions } from './view';
import { fromPxts, FromPxtsResult } from './pxts/fromPxts';
import { alignToBase } from './pxts/align';
import { toPxts } from './pxts/toPxts';
import { PxtsMapper } from './pxts/mapper';
import { WorkspaceIndex, uriToPath, isSourceFile, translators } from './workspace';
import { ProvideXBridge, BridgeDiagnostic, InitInfo } from './bridge';

interface Settings {
  home: string;
  bridge: { enabled: boolean };
  diagnostics: { useProvideX: 'off' | 'onSave' | 'onType'; undefinedLabels: boolean; unusedLabels: boolean; blockStructure: boolean };
  format: { keywordCase: 'upper' | 'lower' | 'preserve'; indentBlocks: boolean; indentSize: number; spacing: boolean };
  readable: { splitStatements: boolean; expandIf: boolean; omitLet: boolean; spacing: boolean; indent: boolean };
  classPath: string[];
}

const defaults: Settings = {
  home: '',
  bridge: { enabled: true },
  diagnostics: { useProvideX: 'onSave', undefinedLabels: true, unusedLabels: false, blockStructure: true },
  format: { keywordCase: 'upper', indentBlocks: true, indentSize: 2, spacing: true },
  readable: { splitStatements: true, expandIf: true, omitLet: true, spacing: true, indent: true },
  classPath: [],
};

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ------------------------------------------------------------------ ProvideX/TS (.pxts) documents
// A .pxts document is translated to ProvideX; every ProvideX feature runs on the translation and positions are
// mapped back through the token-level segment map.
interface PxtsInfo { version: number; res: FromPxtsResult; mapper: PxtsMapper }
const pxtsCache = new Map<string, PxtsInfo>();

function isPxts(uri: string): boolean {
  const td = documents.get(uri);
  if (td) return td.languageId === 'pxts';
  return /\.pxts$/i.test(uri) || pxtsCache.has(uri);
}

function pxtsInfo(uri: string, text?: string, version = -1): PxtsInfo | undefined {
  const td = documents.get(uri);
  const v = td ? td.version : version;
  const c = pxtsCache.get(uri);
  if (c && c.version === v && v !== -1) return c;
  const src = td ? td.getText() : text;
  if (src === undefined) return c;
  const res = fromPxts(src);
  const info = { version: v, res, mapper: new PxtsMapper(res) };
  pxtsCache.set(uri, info);
  return info;
}

/** Maps ranges/locations in a ProvideX-side result back to .pxts positions. */
function mapOut(r: unknown, ctxUri: string): unknown {
  const mapperFor = (u: string) => (isPxts(u) ? pxtsInfo(u)?.mapper : undefined);
  const isRange = (x: unknown): x is Range => !!x && typeof x === 'object' && 'start' in (x as object) && 'end' in (x as object) && typeof (x as Range).start?.line === 'number';
  const walk = (o: unknown, uri: string): unknown => {
    if (Array.isArray(o)) return o.map((x) => walk(x, uri));
    if (!o || typeof o !== 'object') return o;
    const obj = { ...(o as Record<string, unknown>) };
    const own = typeof obj.uri === 'string' ? (obj.uri as string) : uri;
    const m = mapperFor(own);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === 'changes' && v && typeof v === 'object') {
        const ch: Record<string, unknown> = {};
        for (const [u, edits] of Object.entries(v as Record<string, unknown>)) ch[u] = walk(edits, u);
        obj[k] = ch;
      } else if (isRange(v) && m) obj[k] = m.rangeToTs(v);
      else if (v && typeof v === 'object') obj[k] = walk(v, own);
    }
    if (m && typeof obj.startLine === 'number' && typeof obj.endLine === 'number') { obj.startLine = m.lineToTs(obj.startLine as number); obj.endLine = m.lineToTs(obj.endLine as number); }
    if (m && isRange(o)) return m.rangeToTs(o as Range);
    return obj;
  };
  return walk(r, ctxUri);
}

/** Wraps a document-scoped request handler so it also serves .pxts documents. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withPxts(name: string, h: (...a: any[]) => any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (p: any, ...rest: any[]) => {
    const uri: string | undefined = p?.textDocument?.uri;
    if (!uri || !isPxts(uri)) return h(p, ...rest);
    if (['onCodeAction', 'onCodeLens'].includes(name)) return [];
    const info = pxtsInfo(uri)!;
    const p2 = p.position ? { ...p, position: info.mapper.toPvx(p.position) } : p;
    const r = await h(p2, ...rest);
    if (name === 'onCompletion') return pxtsCompletions(r);
    if (name === 'onPrepareRename' && r && 'range' in r) return { ...r, range: info.mapper.rangeToTs(r.range) };
    return mapOut(r, uri);
  };
}

for (const m of ['onHover', 'onCompletion', 'onSignatureHelp', 'onDefinition', 'onImplementation', 'onReferences', 'onDocumentHighlight', 'onPrepareRename', 'onRenameRequest', 'onDocumentSymbol', 'onFoldingRanges', 'onDocumentLinks', 'onCodeAction', 'onCodeLens']) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = connection as any;
  const orig = c[m].bind(connection);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c[m] = (h: any) => orig(withPxts(m, h));
}

const PXTS_KEYWORDS = ['if', 'else', 'for', 'to', 'step', 'while', 'repeat', 'until', 'switch', 'case', 'default', 'break', 'continue', 'return', 'function', 'let', 'const', 'class', 'extends', 'public', 'private', 'readonly', 'constructor', 'destructor', 'new', 'global', 'select', 'from', 'where', 'begin', 'end', 'try', 'catch', 'finally', 'goto', 'gosub', 'exitto', 'def', 'this', 'pvx'];

/** Adapts ProvideX completion items to .pxts spelling. */
function pxtsCompletions(r: unknown): unknown {
  if (!Array.isArray(r)) return r;
  const items = (r as CompletionItem[]).filter((i) => i.kind !== CompletionItemKind.Snippet && !(i.kind === CompletionItemKind.Keyword && /^[A-Z_ ]+$/.test(i.label) && !['PRINT', 'READ', 'WRITE', 'OPEN', 'CLOSE', 'INPUT', 'EXTRACT', 'FIND', 'REMOVE', 'CALL', 'PERFORM', 'RUN', 'DIM', 'EXIT', 'STOP', 'ON', 'SETERR', 'SETESC', 'ENTER', 'DROP', 'MSGBOX', 'SET_PARAM', 'PRECISION', 'EXECUTE', 'PROCESS'].includes(i.label)));
  for (const i of items) {
    if (i.kind === CompletionItemKind.Function && /^[A-Z][A-Z0-9_]*$/.test(i.label)) {
      i.label = i.label.toLowerCase();
      if (typeof i.insertText === 'string') i.insertText = i.insertText.replace(/^[A-Z][A-Z0-9_]*/, (x) => x.toLowerCase());
    } else if (i.kind === CompletionItemKind.Keyword && /^[A-Z_]+$/.test(i.label)) i.label = i.insertText = i.label.toLowerCase();
    else if ((i.kind === CompletionItemKind.Variable || i.kind === CompletionItemKind.Text) && i.label.includes('.')) i.label = i.label.replace(/\./g, '::');
    else if (i.label === '_OBJ') i.label = 'this';
    else if (i.kind === CompletionItemKind.Function && /^FN_/i.test(i.label)) { i.label = i.label.slice(3); if (typeof i.insertText === 'string') i.insertText = i.insertText.slice(3); }
  }
  for (const k of PXTS_KEYWORDS) items.push({ label: k, kind: CompletionItemKind.Keyword, sortText: '2' + k });
  return items;
}
const parsed = new Map<string, { version: number; doc: ParsedDoc }>();
const index = new WorkspaceIndex();
// .pxts files on disk are indexed through their ProvideX translation; keep the mapper for cross-file locations
translators.pxts = (text, fsPath) => {
  const res = fromPxts(text);
  pxtsCache.set(URI.file(fsPath).toString(), { version: -2, res, mapper: new PxtsMapper(res) });
  return res.text;
};
const bridgeDiags = new Map<string, Diagnostic[]>();
let settings: Settings = defaults;
let hasConfig = false;
let bridge: ProvideXBridge | undefined;
let bridgeScript = '';
let detectedHome = '';
let candidateHomes: string[] = [];
let activeHome = '';
let activeInfo: InitInfo | undefined;

const tokenTypes = ['keyword', 'function', 'variable', 'parameter', 'property', 'method', 'label', 'class', 'macro', 'string', 'number', 'operator', 'enumMember', 'type'];
const tokenModifiers = ['declaration', 'readonly', 'defaultLibrary', 'static', 'modification'];
const legend: SemanticTokensLegend = { tokenTypes, tokenModifiers };

function getDoc(uri: string): ParsedDoc | undefined {
  const td = documents.get(uri);
  if (!td) {
    const p = uriToPath(uri);
    return p ? index.getFile(p)?.doc : undefined;
  }
  const c = parsed.get(uri);
  if (c && c.version === td.version) return c.doc;
  const doc = parse(td.languageId === 'pxts' ? pxtsInfo(uri)!.res.text : td.getText());
  parsed.set(uri, { version: td.version, doc });
  index.update(uri, doc);
  return doc;
}

const toRange = (s: Span) => Range.create(s.line, s.start, s.line, s.end);
const tokRange = (line: number, t: Token) => Range.create(line, t.start, line, t.end);

// ------------------------------------------------------------------ lifecycle
connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfig = !!params.capabilities.workspace?.configuration;
  const init = (params.initializationOptions ?? {}) as { bridgeScript?: string; detectedHome?: string; candidateHomes?: string[] };
  bridgeScript = init.bridgeScript ?? path.join(__dirname, '..', 'bridge', 'pvxbridge.ps1');
  detectedHome = init.detectedHome ?? '';
  candidateHomes = init.candidateHomes ?? [];
  const folders = (params.workspaceFolders ?? []).map((f) => URI.parse(f.uri).fsPath);
  if (!folders.length && params.rootUri) folders.push(URI.parse(params.rootUri).fsPath);
  index.setFolders(folders);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ["'", '"', '=', ' ', ',', '(', '*'], resolveProvider: false },
      hoverProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      definitionProvider: true,
      implementationProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      foldingRangeProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentHighlightProvider: true,
      documentLinkProvider: { resolveProvider: false },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorRewrite] },
      callHierarchyProvider: true,
      codeLensProvider: { resolveProvider: false },
      semanticTokensProvider: { legend, full: true, range: false },
    },
  };
});

connection.onInitialized(async () => {
  if (hasConfig) connection.client.register(DidChangeConfigurationNotification.type, undefined);
  await loadSettings();
  void setupBridge();
  const t0 = Date.now();
  const n = index.scan();
  connection.console.log(`ProvideX: indexed ${n} source files in ${Date.now() - t0}ms`);
});

async function loadSettings() {
  if (!hasConfig) return;
  const s = await connection.workspace.getConfiguration('providex');
  settings = {
    ...defaults, ...s,
    bridge: { ...defaults.bridge, ...(s?.bridge ?? {}) },
    diagnostics: { ...defaults.diagnostics, ...(s?.diagnostics ?? {}) },
    format: { ...defaults.format, ...(s?.format ?? {}) },
    readable: { ...defaults.readable, ...(s?.readable ?? {}) },
    classPath: Array.isArray(s?.classPath) ? s.classPath : [],
  };
  updateClassPath();
}

/** Classes are looked up next to the install the project belongs to (configured/nearest), then next to the active one. */
function updateClassPath() {
  const cp = [...settings.classPath];
  for (const home of new Set([settings.home || detectedHome, activeHome].filter(Boolean))) {
    // Sage 100: compiled classes live in MAS90\<module>\ next to Home
    const mas = path.dirname(home);
    if (fs.existsSync(path.join(mas, 'SY'))) cp.push(mas);
    cp.push(path.join(home, 'Lib', '_OBJ'), path.join(home, 'Lib'));
  }
  index.classPath = cp;
}

function currentHome(): string { return activeHome || settings.home || detectedHome; }

const isDevelopment = () => !!bridge && activeInfo?.development === true;

/** Explains why an operation that needs LIST/MERGE is unavailable. */
function licenceMessage(op: string): string {
  if (!bridge) return `${op} needs an installed ProvideX: set providex.home and enable providex.bridge.enabled.`;
  return `${op} needs a ProvideX development licence. The ProvideX at "${activeHome}" has a runtime (end-user) activation, which refuses to list or edit programs (ProvideX Error #61 "Authorization failure"). ` +
    `Point providex.home at a ProvideX activated for development, or activate this one for development with Sage's activation utility (pvxwactv.exe in that folder). Highlighting, completion, navigation and the built-in checks keep working.`;
}

// Requests can arrive while the installs are still being probed (e.g. a .pvc opened at startup):
// wait for the first probe and any re-probe in progress before deciding.
let resolveFirstSetup!: () => void;
const firstSetup = new Promise<void>((r) => (resolveFirstSetup = r));
let bridgeSetup: Promise<void> = Promise.resolve();

async function bridgeSettled(): Promise<void> {
  await Promise.race([firstSetup, new Promise((r) => setTimeout(r, 60000))]);
  await bridgeSetup.catch(() => undefined);
}

async function requireDevelopment(op: string): Promise<ProvideXBridge> {
  await bridgeSettled();
  if (!isDevelopment()) throw new Error(licenceMessage(op));
  return bridge!;
}

let bridgeKey = '';
let bridgeGeneration = 0;

interface HomeCheck { home: string; development: boolean; error?: string }

/**
 * Starts the bridge on the best ProvideX install: the configured (or nearest) one if it has a development
 * activation, otherwise the first detected install that has one, otherwise the first that starts at all.
 */
function setupBridge(force = false): Promise<void> {
  const order = [...new Set([settings.home, detectedHome, ...candidateHomes].filter(Boolean))];
  const key = JSON.stringify([settings.bridge.enabled, order]);
  // same settings: join the probe already running (or finished) instead of replacing it
  if (!force && key === bridgeKey) return bridgeSetup;
  bridgeKey = key;
  bridgeSetup = doSetupBridge(order).finally(() => resolveFirstSetup());
  return bridgeSetup;
}

async function doSetupBridge(order: string[]): Promise<void> {
  const gen = ++bridgeGeneration;
  if (bridge) { bridge.dispose(); bridge = undefined; }
  activeHome = ''; activeInfo = undefined; index.decompile = undefined;
  if (!settings.bridge.enabled || process.platform !== 'win32' || !fs.existsSync(bridgeScript) || !order.length) {
    connection.sendNotification('providex/licence', { state: 'disabled', checked: [] });
    return;
  }
  const checked: HomeCheck[] = [];
  let first: { b: ProvideXBridge; info: InitInfo; home: string } | undefined;
  let chosen: typeof first;
  for (const home of order) {
    const b = new ProvideXBridge(bridgeScript, () => home, (m) => connection.console.log(m));
    try {
      const info = await b.info();
      checked.push({ home, development: info.development });
      connection.console.log(`ProvideX at ${home}: ${info.development ? 'development' : 'runtime-only'} activation`);
      if (info.development) chosen = { b, info, home };
      else if (!first) first = { b, info, home };
      else b.dispose();
    } catch (e) {
      checked.push({ home, development: false, error: (e as Error).message });
      b.dispose();
    }
    if (gen !== bridgeGeneration) { chosen?.b.dispose(); first?.b.dispose(); return; }
    if (chosen) break;
  }
  if (chosen && first) first.b.dispose();
  const pick = chosen ?? first;
  bridge = pick?.b;
  activeHome = pick?.home ?? '';
  activeInfo = pick?.info;
  updateClassPath();
  if (isDevelopment()) {
    index.decompile = async (p) => (await bridge!.list(p)).lines.map((l) => l.text).join('\r\n');
    if (settings.diagnostics.useProvideX !== 'off') for (const d of documents.all()) validateWithProvideX(d);
  }
  const preferred = settings.home || detectedHome;
  const state = !pick ? 'unavailable' : pick.info.development ? (preferred && pick.home.toLowerCase() !== preferred.toLowerCase() ? 'fallback' : 'ok') : 'runtime';
  connection.sendNotification('providex/licence', { state, home: activeHome, preferred, configured: settings.home, checked });
}

connection.onDidChangeConfiguration(async () => {
  await loadSettings();
  void setupBridge();
  for (const d of documents.all()) validate(d);
});

connection.onDidChangeWatchedFiles((p) => {
  for (const c of p.changes) {
    const fp = uriToPath(c.uri);
    if (!fp || !isSourceFile(fp)) continue;
    if (c.type === FileChangeType.Deleted) index.remove(fp);
    else if (!documents.get(c.uri)) index.indexFile(fp);
  }
});

// ------------------------------------------------------------------ diagnostics
const timers = new Map<string, NodeJS.Timeout>();
documents.onDidChangeContent((e) => {
  const old = timers.get(e.document.uri);
  if (old) clearTimeout(old);
  timers.set(e.document.uri, setTimeout(() => {
    validate(e.document);
    if (settings.diagnostics.useProvideX === 'onType') validateWithProvideX(e.document);
  }, 250));
});
documents.onDidOpen((e) => { if (settings.diagnostics.useProvideX !== 'off') validateWithProvideX(e.document); });
documents.onDidSave((e) => { if (settings.diagnostics.useProvideX !== 'off') validateWithProvideX(e.document); });
documents.onDidClose((e) => {
  parsed.delete(e.document.uri);
  bridgeDiags.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
  const p = uriToPath(e.document.uri);
  if (p && fs.existsSync(p) && e.document.uri.startsWith('file:')) index.indexFile(p);
});

const sev: Record<string, DiagnosticSeverity> = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information, hint: DiagnosticSeverity.Hint };

function validate(td: TextDocument) {
  const doc = getDoc(td.uri);
  if (!doc) return;
  const probs = analyze(doc, settings.diagnostics);
  const px = isPxts(td.uri) ? pxtsInfo(td.uri) : undefined;
  const diags: Diagnostic[] = probs.map((p) => ({
    range: px ? px.mapper.rangeToTs(toRange(p.span)) : toRange(p.span), message: p.message, severity: sev[p.severity], source: 'providex', code: p.code, data: p.data,
    tags: p.code === 'unused-label' ? [DiagnosticTag.Unnecessary] : undefined,
  }));
  if (px) {
    for (const pr of px.res.problems) diags.push({ range: Range.create(pr.line, pr.col, pr.line, pr.end), message: pr.message, severity: pr.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, source: 'pxts' });
    // generated scaffolding (@pxts lines) never carries user-visible problems
    for (let k = diags.length - 1; k >= 0; k--) if (diags[k].source === 'providex' && /\b(px_|FN_)/.test(diags[k].message)) diags.splice(k, 1);
  }
  connection.sendDiagnostics({ uri: td.uri, diagnostics: [...diags, ...(bridgeDiags.get(td.uri) ?? [])] });
}

async function validateWithProvideX(td: TextDocument) {
  if (!isDevelopment()) return;
  const version = td.version;
  try {
    const px = isPxts(td.uri) ? pxtsInfo(td.uri) : undefined;
    const r = await bridge!.check(px ? px.res.text : td.getText());
    if (px) for (const d of r.diagnostics) d.line = px.mapper.lineToTs(d.line);
    if (documents.get(td.uri)?.version !== version) return;
    bridgeDiags.set(td.uri, r.diagnostics.map((d) => bridgeToDiag(td, d)).concat(r.mergeError ? [{
      range: Range.create(0, 0, 0, 0), severity: DiagnosticSeverity.Error, source: 'ProvideX', message: r.mergeError,
    }] : []));
    validate(td);
  } catch (e) {
    connection.console.log('ProvideX syntax check unavailable: ' + (e as Error).message);
  }
}

function bridgeToDiag(td: TextDocument, d: BridgeDiagnostic): Diagnostic {
  const lineText = td.getText(Range.create(d.line, 0, d.line + 1, 0)).replace(/\r?\n$/, '');
  const m = /^\s*\d*\s*/.exec(lineText)!;
  return {
    range: Range.create(d.line, m[0].length, d.line, lineText.length),
    severity: DiagnosticSeverity.Error,
    source: 'ProvideX',
    code: d.code,
    message: `${errorMessages[String(d.code)]?.text ?? d.message} (ProvideX Error #${d.code})`,
  };
}

// ------------------------------------------------------------------ completion
function kwCase(s: string): string {
  return settings.format.keywordCase === 'lower' ? s.toLowerCase() : s.toUpperCase();
}

function snippetForFunction(name: string): string {
  const sig = functionDocs[name]?.signatures?.[0];
  if (!sig || !sig.params.length) return kwCase(name) + '($1)';
  const req = sig.minArgs ?? sig.params.length;
  const ps = sig.params.slice(0, Math.max(req, 1)).map((p, i) => '${' + (i + 1) + ':' + p.name.replace(/[$}]/g, (c) => '\\' + c) + '}');
  return kwCase(name) + '(' + ps.join(',') + ')';
}

const BLOCK_SNIPPETS: { label: string; body: string; doc: string }[] = [
  { label: 'FOR … NEXT', body: 'FOR ${1:I}=${2:1} TO ${3:10}\n\t$0\nNEXT ${1:I}', doc: 'FOR loop' },
  { label: 'WHILE … WEND', body: 'WHILE ${1:condition}\n\t$0\nWEND', doc: 'WHILE loop' },
  { label: 'REPEAT … UNTIL', body: 'REPEAT\n\t$0\nUNTIL ${1:condition}', doc: 'REPEAT loop' },
  { label: 'IF … THEN { }', body: 'IF ${1:condition} THEN {\n\t$0\n}', doc: 'IF block' },
  { label: 'IF … THEN { } ELSE { }', body: 'IF ${1:condition} THEN {\n\t$2\n} ELSE {\n\t$0\n}', doc: 'IF/ELSE block' },
  { label: 'SWITCH … END SWITCH', body: 'SWITCH ${1:expr}\nCASE ${2:value}\n\t$0\n\tBREAK\nDEFAULT\n\tBREAK\nEND SWITCH', doc: 'SWITCH statement' },
  { label: 'SELECT … NEXT RECORD', body: 'SELECT ${1:*} FROM ${2:chan} BEGIN ${3:key$} END ${4:key$}:\\$FE\\$ WHERE ${5:condition}\n\t$0\nNEXT RECORD', doc: 'SELECT loop over a file' },
  { label: 'TRY … CATCH … END_TRY', body: 'TRY\n\t$1\nCATCH\n\t$0\nEND_TRY', doc: 'Exception handling block' },
  { label: 'DEF CLASS … END DEF', body: 'DEF CLASS "${1:ClassName}"\n\t! Public properties\n\tPROPERTY ${2:Name\\$}\n\t! Public methods\n\tFUNCTION ${3:Method}()${4:METHOD_LABEL}\nEND DEF\n\n${4:METHOD_LABEL}:\n$0\nRETURN 1\n', doc: 'Class definition' },
  { label: 'DEF FN', body: 'DEF FN${1:NAME}(${2:X})=${0:X}', doc: 'Single-line user function' },
  { label: 'OPEN … READ … CLOSE', body: 'LET ${1:ch}=HFN; OPEN (${1:ch},ERR=${2:*NEXT})"${3:file}"\nREAD (${1:ch},KEY=${4:key$},DOM=*NEXT)${5:rec$}\nCLOSE (${1:ch})', doc: 'Open/read/close a file' },
];

connection.onCompletion(async (p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const line = doc.lines[p.position.line] ?? '';
  const before = line.slice(0, p.position.character);
  const items: CompletionItem[] = [];

  // inside a string?
  const quotes = (before.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) {
    const strStart = before.lastIndexOf('"');
    const pre = before.slice(0, strStart).trimEnd().toUpperCase();
    if (/\bNEW\s*\(\s*$/.test(pre) || /\b(LIKE|DEF\s+CLASS)\s*("[^"]*"\s*,\s*)*$/.test(pre)) {
      for (const f of index.allFiles()) for (const c of f.doc.classes) items.push({ label: c.name, kind: CompletionItemKind.Class, detail: path.basename(f.fsPath) });
    } else if (/\b(CALL|PERFORM|RUN|LOAD|MERGE|PROCESS)\s*$/.test(pre)) {
      const seen = new Set<string>();
      for (const f of index.allFiles()) {
        const b = path.basename(f.fsPath).replace(/\.(pvx|pvt|txt|pvxsrc|bbx|pxs)$/i, '');
        if (!seen.has(b)) { seen.add(b); items.push({ label: b, kind: CompletionItemKind.File, detail: f.fsPath }); }
      }
      // ;ENTRY labels
      const m = /([^";]*);([^";]*)$/.exec(before.slice(strStart + 1));
      if (m) {
        const fp = index.locateProgram(m[1]);
        const f = fp ? index.getFile(fp) : undefined;
        if (f) return [...f.doc.labels.values()].map((d) => ({ label: d[0].name, kind: CompletionItemKind.Function }));
      }
    }
    return items;
  }

  // object members: something' (no space before the quote)
  const memberM = /([A-Za-z_%][A-Za-z0-9_.]*[$%]?|\)|\])'([A-Za-z0-9_.]*)$/.exec(before);
  if (memberM) {
    const t = tokenAt(doc, p.position.line, p.position.character - memberM[2].length - 1);
    const objName = memberM[1];
    const cls = objName === ')' || objName === ']' ? undefined : inferObjectClass(doc, objName === '_obj' ? '_OBJ' : objName);
    const seen = new Set<string>();
    if (cls) {
      for (const { member, owner } of await index.classMembers(cls)) {
        const key = member.name.toUpperCase();
        if (seen.has(key)) continue;
        if (member.local && objName.toUpperCase() !== '_OBJ') continue;
        seen.add(key);
        items.push(memberItem(member, owner.name));
      }
    }
    // members used on this object elsewhere in the document
    doc.lexed.forEach((lx) => lx.tokens.forEach((tk, i) => {
      if (tk.kind === T.Member && i > 0 && lx.tokens[i - 1].upper === objName.toUpperCase()) {
        const n = tk.text.slice(1);
        if (!seen.has(n.toUpperCase())) { seen.add(n.toUpperCase()); items.push({ label: n, kind: lx.tokens[i + 1]?.text === '(' ? CompletionItemKind.Method : CompletionItemKind.Property }); }
      }
    }));
    void t;
    return items;
  }

  // mnemonic 'XX'
  if (/(^|[^A-Za-z0-9_$%)\]])'[A-Za-z0-9_+-]*$/.test(before)) {
    const inSetParam = /\bSET_PARAM\b[^;]*$/i.test(before) || /\bPRM\s*\(\s*'[A-Z]*$/i.test(before);
    if (inSetParam) {
      for (const [k, v] of Object.entries(systemParams)) items.push({ label: k, kind: CompletionItemKind.EnumMember, detail: v.title, documentation: v.doc ? md(v.doc) : undefined });
      return items;
    }
    for (const m of MNEMONICS) items.push({ label: m, kind: CompletionItemKind.Constant, detail: 'mnemonic', documentation: mnemonicDocs[m] ? md(mnemonicDocs[m]) : undefined });
    return items;
  }

  // branch targets
  if (/\b(GOTO|GOSUB|SETERR|SETESC|EXITTO|RESTORE|THEN|ELSE)\s+[A-Za-z0-9_.]*$/i.test(before) || /,\s*(ERR|END|DOM|BSY)\s*=\s*\*?[A-Za-z0-9_.]*$/i.test(before) || /\b(GET|SET)\s+[A-Za-z0-9_.]*$/i.test(before) && /\bPROPERTY\b/i.test(before) || /\bON\b.*\b(GOTO|GOSUB)\b[^;]*,\s*[A-Za-z0-9_.]*$/i.test(before) || /\bFUNCTION\b.*\)\s*[A-Za-z0-9_.]*$/i.test(before)) {
    const isThen = /\b(THEN|ELSE)\s+[A-Za-z0-9_.]*$/i.test(before);
    for (const [, defs] of doc.labels) {
      const d = defs[0];
      const cm = leadingComments(doc, d.span.line, 2);
      items.push({ label: d.name, kind: CompletionItemKind.Reference, detail: 'label' + (cm.length ? ' — ' + cm[cm.length - 1] : ''), sortText: '0' + d.name });
    }
    if (/=\s*\*?[A-Za-z]*$/.test(before) || /\b(EXITTO)\s+\*?[A-Za-z]*$/i.test(before) || /\bON\b.*\bGOTO\b/i.test(before)) {
      for (const [k, v] of Object.entries(specialTargetDocs)) items.push({ label: k, kind: CompletionItemKind.Keyword, documentation: md(String(v)), filterText: k, insertText: /\*\w*$/.test(before) ? k.slice(1) : k });
      if (!Object.keys(specialTargetDocs).length) for (const k of ['*NEXT', '*SAME', '*RETRY', '*BREAK', '*CONTINUE', '*PROCEED', '*RETURN', '*END', '*ESCAPE']) items.push({ label: k, kind: CompletionItemKind.Keyword, insertText: /\*\w*$/.test(before) ? k.slice(1) : k });
    }
    if (doc.numbered) {
      for (const [n, l] of doc.lineNumbers) {
        const text = doc.lines[l].trim();
        items.push({ label: String(n).padStart(4, '0'), kind: CompletionItemKind.Reference, detail: text.slice(0, 80), sortText: '1' + String(n).padStart(6, '0') });
      }
    }
    if (!isThen) return items;
  }

  // I/O options after a comma inside parentheses
  if (/[(,]\s*[A-Za-z]{0,3}$/.test(before) && openParenIsIO(before)) {
    for (const o of FILE_OPTIONS) items.push({ label: o + '=', kind: CompletionItemKind.Field, documentation: optionDocs[o] ? md(optionDocs[o]) : undefined, sortText: '0' + o });
  }

  // statement start?
  const stmtStart = /(^\s*(\d+\s+)?([A-Za-z_][A-Za-z0-9_.]*:\s*)?|;\s*|\{\s*|\bTHEN\s+|\bELSE\s+)[A-Za-z_]*$/i.test(before);
  if (stmtStart) {
    for (const d of DIRECTIVES) {
      const doc2 = directiveDocs[d];
      items.push({ label: kwCase(d), kind: CompletionItemKind.Keyword, detail: doc2?.syntax?.[0], documentation: doc2?.doc ? md(doc2.doc) : undefined, sortText: '2' + d });
    }
    for (const s of BLOCK_SNIPPETS) items.push({ label: s.label, kind: CompletionItemKind.Snippet, insertText: s.body, insertTextFormat: InsertTextFormat.Snippet, documentation: s.doc, sortText: '3' + s.label });
  }
  for (const f of FUNCTIONS) {
    const d = functionDocs[f];
    items.push({ label: kwCase(f), kind: CompletionItemKind.Function, detail: d?.signatures?.[0]?.label, documentation: d?.doc ? md(d.doc) : undefined, insertText: snippetForFunction(f), insertTextFormat: InsertTextFormat.Snippet, sortText: '4' + f });
  }
  for (const s of SYSVARS) items.push({ label: kwCase(s), kind: CompletionItemKind.Constant, detail: 'system variable', documentation: sysvarDocs[s]?.doc ? md(sysvarDocs[s].doc!) : undefined, sortText: '5' + s });
  items.push({ label: '_OBJ', kind: CompletionItemKind.Constant, detail: 'current object', sortText: '5_OBJ' });
  for (const [, fn] of doc.fns) items.push({ label: fn.name, kind: CompletionItemKind.Function, detail: `DEF ${fn.name}(${fn.params.join(',')})`, insertText: fn.name + '(' + fn.params.map((pp, i) => '${' + (i + 1) + ':' + pp.replace(/\$/g, '\\$') + '}').join(',') + ')', insertTextFormat: InsertTextFormat.Snippet, sortText: '1' + fn.name });
  for (const [, v] of doc.vars) {
    if (v.name.includes("'")) continue;
    items.push({ label: v.name, kind: v.kind === 'string' ? CompletionItemKind.Text : CompletionItemKind.Variable, detail: v.kind + ' variable' + (v.isParam ? ' (parameter)' : ''), sortText: '0' + v.name });
  }
  for (const w of ['THEN', 'ELSE', 'TO', 'STEP', 'AND', 'OR', 'FROM', 'WHERE', 'BEGIN', 'END', 'RECORD', 'IOL=']) items.push({ label: kwCase(w), kind: CompletionItemKind.Keyword, sortText: '6' + w });
  return items;
});

function openParenIsIO(before: string): boolean {
  let d = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ')') d++;
    else if (c === '(') {
      if (d === 0) {
        const head = before.slice(0, i).trimEnd();
        return /\b(READ|WRITE|PRINT|INPUT|OPEN|CLOSE|EXTRACT|FIND|REMOVE|UPDATE|INSERT|LOCK|UNLOCK|PURGE|ERASE|SERIAL|KEYED|DIRECT|SORT|INDEXED|RECORD|DATA|KEY|KEF|KEL|KEN|KEP|KEC|FIB|FIN|IND|RNO|REC|TBL|NUM|STR|EVN|EVS|MSK|POS|DIR|PTH|LNO|CHG|IOL)$/i.test(head);
      }
      d--;
    } else if (c === '"') return false;
  }
  return false;
}

function memberItem(m: ClassMember, owner: string): CompletionItem {
  if (m.kind === 'function') {
    const params = m.params ?? [];
    return {
      label: m.name, kind: CompletionItemKind.Method, detail: `${owner}'${m.signature}`,
      insertText: m.name + '(' + params.map((pp, i) => '${' + (i + 1) + ':' + pp.replace(/\$/g, '\\$') + '}').join(',') + ')',
      insertTextFormat: InsertTextFormat.Snippet,
    };
  }
  return { label: m.name, kind: CompletionItemKind.Property, detail: `${owner}'${m.name}${m.local ? ' (local)' : ''}` };
}

// ------------------------------------------------------------------ hover
connection.onHover(async (p): Promise<Hover | null> => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return null;
  const sym = symbolAt(doc, p.position.line, p.position.character);
  if (!sym) {
    const t = tokenAt(doc, p.position.line, p.position.character);
    // ERR=nn / ERR<>nn comparisons: show the error text
    if (t && t.kind === T.Number) {
      const lx = doc.lexed[p.position.line].tokens;
      const i = lx.indexOf(t);
      const prev = lx[i - 1], prev2 = lx[i - 2];
      if (prev && prev.kind === T.Operator && prev2 && (prev2.upper === 'ERR' || prev2.upper === 'RET') && prev2.role !== 'fileOption') {
        const h = errorHover(parseInt(t.text, 10));
        if (h) return { contents: md(h), range: tokRange(p.position.line, t) };
      }
    }
    return null;
  }
  const range = tokRange(sym.line, sym.token);
  let value: string | undefined;
  switch (sym.kind) {
    case 'builtin': {
      if (sym.role === 'function') value = functionHover(sym.name);
      else if (sym.role === 'directive' || sym.role === 'clause') value = directiveHover(sym.name) ?? directiveHover(multiWordAt(doc, sym)) ?? `**${sym.name}**`;
      else if (sym.role === 'sysvar') value = sysvarHover(sym.name);
      else if (sym.role === 'fileOption') value = optionHover(sym.name);
      else if (sym.role === 'special') value = specialHover(sym.name);
      else if (sym.role === 'mnemonic') {
        const stmt = statementAt(doc, sym.line, sym.token.start);
        const key = sym.token.text.replace(/'/g, '');
        if (stmt && (stmt.kind === 'SET_PARAM' || /PRM\s*\(\s*$/i.test(doc.lines[sym.line].slice(0, sym.token.start)))) value = paramHover(key) ?? mnemonicHover(sym.token.text);
        else value = mnemonicHover(sym.token.text);
      }
      break;
    }
    case 'label': {
      const d = labelDef(doc, sym.name);
      if (d) value = labelHover(doc, sym.name, d.line, leadingComments(doc, d.line));
      else value = `Label **${sym.name}** is not defined in this program`;
      break;
    }
    case 'lineno': {
      const l = doc.lineNumbers.get(sym.n);
      if (l !== undefined) value = labelHover(doc, String(sym.n), l, leadingComments(doc, l));
      else {
        const nx = nextStatementNumber(doc, sym.n);
        value = nx !== undefined ? `Statement ${sym.n} does not exist; control passes to statement ${nx}:\n\n\`\`\`providex\n${doc.lines[doc.lineNumbers.get(nx)!].trim()}\n\`\`\`` : `Statement ${sym.n} does not exist`;
      }
      break;
    }
    case 'variable': {
      const v = doc.vars.get(sym.name.toUpperCase());
      if (!v) break;
      const first = v.defs[0];
      value = '```providex\n' + `${v.global ? 'global ' : ''}${v.kind} ${v.name}` + '\n```';
      if (v.isParam) value += '\n\nparameter';
      if (first) value += `\n\nFirst assigned at line ${first.line + 1}: \`${doc.lines[first.line].trim().slice(0, 120)}\``;
      const tc = first ? trailingComment(doc, first.line) : undefined;
      if (tc) value += '\n\n' + tc;
      const cls = inferObjectClass(doc, v.name);
      if (cls) value += `\n\nobject of class \`${cls}\``;
      break;
    }
    case 'fn': {
      const f = doc.fns.get(sym.name.toUpperCase());
      if (f) value = '```providex\nDEF ' + f.name + '(' + f.params.join(',') + ')\n```' + (leadingComments(doc, f.span.line).length ? '\n\n' + leadingComments(doc, f.span.line).join('\n\n') : '');
      break;
    }
    case 'member': {
      const res = await resolveMember(doc, sym);
      if (res) value = memberHover(res.member, res.owner, leadingComments(res.file.doc, res.member.span.line).concat(trailingComment(res.file.doc, res.member.span.line) ?? []));
      break;
    }
    case 'class': {
      const c = await index.resolveClass(sym.name);
      if (c) value = '```providex\nDEF CLASS "' + c.cls.name + '"' + (c.cls.likes.length ? '\nLIKE ' + c.cls.likes.map((l) => `"${l}"`).join(',') : '') + '\n```\n\n' + `${c.cls.members.filter((m) => !m.local).length} public members — ${path.basename(c.file.fsPath)}`;
      break;
    }
    case 'program': {
      const fp = index.locateProgram(sym.name);
      value = fp ? `Program \`${fp}\`` : `Program \`${sym.name}\` (not found in workspace)`;
      break;
    }
  }
  return value ? { contents: md(value), range } : null;
});

function multiWordAt(doc: ParsedDoc, sym: SymbolRef): string {
  const lx = doc.lexed[sym.line].tokens;
  const i = lx.indexOf(sym.token);
  const next = lx[i + 1];
  if (next && next.kind === T.Word) return sym.token.upper + ' ' + next.upper;
  const prev = lx[i - 1];
  if (prev && prev.kind === T.Word) return prev.upper + ' ' + sym.token.upper;
  return sym.token.upper;
}

async function resolveMember(doc: ParsedDoc, sym: Extract<SymbolRef, { kind: 'member' }>) {
  // definition inside this file's own class header
  for (const c of doc.classes) for (const m of c.members) if (m.span.line === sym.line && m.span.start === sym.token.start) {
    const file = index.allFiles().find((f) => f.doc === doc) ?? { uri: '', fsPath: '', doc, mtime: 0 };
    return { member: m, owner: c.name, file };
  }
  const objName = sym.object?.text;
  const cls = objName ? inferObjectClass(doc, objName) : undefined;
  const key = sym.name.toUpperCase();
  if (cls) {
    for (const r of await index.classMembers(cls)) if (r.member.name.toUpperCase() === key && (r.member.kind === 'function') === sym.isMethod) return { member: r.member, owner: r.owner.name, file: r.file };
    for (const r of await index.classMembers(cls)) if (r.member.name.toUpperCase() === key) return { member: r.member, owner: r.owner.name, file: r.file };
  }
  // fall back to any indexed class declaring a member with that name
  for (const f of index.allFiles()) for (const c of f.doc.classes) for (const m of c.members) if (m.name.toUpperCase() === key && (m.kind === 'function') === sym.isMethod) return { member: m, owner: c.name, file: f };
  return undefined;
}

// ------------------------------------------------------------------ signature help
connection.onSignatureHelp(async (p): Promise<SignatureHelp | null> => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return null;
  const lx = doc.lexed[p.position.line];
  const col = p.position.character;
  // find the innermost open call before the cursor
  const toks = lx.tokens.filter((t) => t.end <= col && t.kind !== T.Comment);
  let depth = 0, active = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) depth++;
    else if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) {
      if (depth === 0) {
        if (t.text === '[') return null;
        const fnTok = toks[i - 1];
        if (!fnTok) return null;
        let sigs: SignatureInformation[] = [];
        if (fnTok.kind === T.Word && fnTok.role === 'function') {
          const d = functionDocs[fnTok.upper];
          sigs = (d?.signatures ?? [{ label: fnTok.upper + '(...)', params: [] }]).map((s) => SignatureInformation.create(s.label, d?.doc, ...s.params.map((pp) => ParameterInformation.create(pp.name, pp.doc))));
        } else if (fnTok.kind === T.Word && fnTok.role === 'userFunction') {
          const f = doc.fns.get(fnTok.upper);
          if (f) sigs = [SignatureInformation.create(`${f.name}(${f.params.join(',')})`, undefined, ...f.params.map((pp) => ParameterInformation.create(pp)))];
        } else if (fnTok.kind === T.Member || (fnTok.kind === T.Word && fnTok.role === 'method')) {
          const sym = symbolAt(doc, p.position.line, fnTok.start + 1);
          if (sym && sym.kind === 'member') {
            const r = await resolveMember(doc, sym);
            if (r && r.member.kind === 'function') sigs = [SignatureInformation.create(`${r.owner}'${r.member.signature}`, leadingComments(r.file.doc, r.member.span.line).join('\n') || undefined, ...(r.member.params ?? []).map((pp) => ParameterInformation.create(pp)))];
          }
        }
        if (!sigs.length) return null;
        // choose a signature with enough parameters
        let activeSig = 0;
        sigs.forEach((s, k) => { if ((s.parameters?.length ?? 0) > active && activeSig === 0 && (sigs[activeSig].parameters?.length ?? 0) <= active) activeSig = k; });
        return { signatures: sigs, activeSignature: activeSig, activeParameter: active };
      }
      depth--;
    } else if (depth === 0 && t.kind === T.Punct && t.text === ',') active++;
  }
  return null;
});

// ------------------------------------------------------------------ navigation
async function definitionsOf(uri: string, doc: ParsedDoc, sym: SymbolRef, implementation = false): Promise<Location[]> {
  switch (sym.kind) {
    case 'label': { const d = labelDef(doc, sym.name); return d ? [Location.create(uri, toRange(d))] : []; }
    case 'lineno': {
      const d = lineDef(doc, sym.n) ?? (() => { const nx = nextStatementNumber(doc, sym.n); return nx !== undefined ? lineDef(doc, nx) : undefined; })();
      return d ? [Location.create(uri, toRange(d))] : [];
    }
    case 'variable': {
      const v = doc.vars.get(sym.name.toUpperCase());
      if (v?.defs.length) return [Location.create(uri, toRange(v.defs[0]))];
      // class property declared in the class header
      for (const c of doc.classes) for (const m of c.members) if (m.name.toUpperCase() === sym.name.toUpperCase()) return [Location.create(uri, toRange(m.span))];
      return [];
    }
    case 'fn': { const f = doc.fns.get(sym.name.toUpperCase()); return f ? [Location.create(uri, toRange(f.span))] : []; }
    case 'member': {
      const r = await resolveMember(doc, sym);
      if (!r) return [];
      const fileUri = r.file.uri || uri;
      if (implementation || (r.member.span.line === sym.line && r.file.doc === doc)) {
        const lbl = r.member.kind === 'function' ? r.member.label : r.member.getLabel;
        const d = lbl ? labelDef(r.file.doc, lbl) : undefined;
        if (d) return [Location.create(fileUri, toRange(d))];
      }
      return [Location.create(fileUri, toRange(r.member.span))];
    }
    case 'class': {
      const c = await index.resolveClass(sym.name);
      return c ? [Location.create(c.file.uri, toRange(c.cls.nameSpan))] : [];
    }
    case 'program': {
      const fp = index.locateProgram(sym.name);
      if (!fp) return [];
      const link = doc.links.find((l) => l.span.line === sym.line && l.span.start === sym.token.start);
      const target = programUri(fp);
      if (link?.entry) {
        const f = index.getFile(fp) ?? index.indexFile(fp);
        const d = f ? labelDef(f.doc, link.entry) : undefined;
        if (d) return [Location.create(target, toRange(d))];
      }
      return [Location.create(target, Range.create(0, 0, 0, 0))];
    }
    default: return [];
  }
}

function programUri(fp: string): string {
  try {
    const fd = fs.openSync(fp, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    if (b.toString('latin1') === '[Pvxprg]') return URI.file(fp).with({ scheme: 'pvxprg' }).toString();
  } catch { /* ignore */ }
  return URI.file(fp).toString();
}

connection.onDefinition(async (p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const sym = symbolAt(doc, p.position.line, p.position.character);
  return sym ? definitionsOf(p.textDocument.uri, doc, sym) : [];
});

connection.onImplementation(async (p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const sym = symbolAt(doc, p.position.line, p.position.character);
  return sym ? definitionsOf(p.textDocument.uri, doc, sym, true) : [];
});

function occurrences(doc: ParsedDoc, sym: SymbolRef): { span: Span; def: boolean }[] {
  switch (sym.kind) {
    case 'label': return labelOccurrences(doc, sym.name);
    case 'lineno': return lineOccurrences(doc, sym.n);
    case 'variable': return varOccurrences(doc, sym.name);
    case 'fn': return fnOccurrences(doc, sym.name);
    case 'member': return memberOccurrences(doc, sym.name);
    default: return [];
  }
}

connection.onReferences(async (p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const sym = symbolAt(doc, p.position.line, p.position.character);
  if (!sym) return [];
  const out: Location[] = [];
  if (sym.kind === 'member' || sym.kind === 'class') {
    // workspace-wide by name
    for (const f of index.allFiles()) {
      const occ = sym.kind === 'member' ? memberOccurrences(f.doc, sym.name) : classOccurrences(f.doc, sym.name);
      for (const o of occ) if (p.context.includeDeclaration || !o.def) out.push(Location.create(f.uri, toRange(o.span)));
    }
    return dedupe(out);
  }
  for (const o of occurrences(doc, sym)) if (p.context.includeDeclaration || !o.def) out.push(Location.create(p.textDocument.uri, toRange(o.span)));
  return out;
});

function classOccurrences(doc: ParsedDoc, name: string): { span: Span; def: boolean }[] {
  const out: { span: Span; def: boolean }[] = [];
  const key = name.toUpperCase();
  doc.lexed.forEach((lx, line) => lx.tokens.forEach((t, i) => {
    if (t.kind !== T.String || t.text.slice(1, -1).toUpperCase() !== key) return;
    const prev = lx.tokens[i - 1], prev2 = lx.tokens[i - 2];
    const isNew = prev?.text === '(' && prev2?.upper === 'NEW';
    if (t.role === 'className' || isNew) out.push({ span: { line, start: t.start, end: t.end }, def: !!doc.classes.find((c) => c.nameSpan.line === line && c.nameSpan.start === t.start) });
  }));
  return out;
}

function dedupe(locs: Location[]): Location[] {
  const seen = new Set<string>();
  return locs.filter((l) => { const k = l.uri + JSON.stringify(l.range); if (seen.has(k)) return false; seen.add(k); return true; });
}

connection.onDocumentHighlight((p): DocumentHighlight[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const sym = symbolAt(doc, p.position.line, p.position.character);
  if (!sym) return [];
  return occurrences(doc, sym).map((o) => DocumentHighlight.create(toRange(o.span), o.def ? DocumentHighlightKind.Write : DocumentHighlightKind.Read));
});

connection.onPrepareRename((p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return null;
  const sym = symbolAt(doc, p.position.line, p.position.character);
  if (!sym || sym.kind === 'builtin' || sym.kind === 'lineno' || sym.kind === 'program' || sym.kind === 'class') return null;
  const t = sym.token;
  const start = t.kind === T.Member ? t.start + 1 : t.start;
  return { range: Range.create(sym.line, start, sym.line, t.end), placeholder: sym.name };
});

connection.onRenameRequest(async (p): Promise<WorkspaceEdit | null> => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return null;
  const sym = symbolAt(doc, p.position.line, p.position.character);
  if (!sym) return null;
  if (sym.kind === 'variable') {
    // keep the type suffix consistent
    const suffix = /[$%]$/.exec(sym.name)?.[0] ?? '';
    if (suffix && !p.newName.endsWith(suffix)) p.newName += suffix;
  }
  if (sym.kind === 'member') {
    const changes: Record<string, TextEdit[]> = {};
    for (const f of index.allFiles()) {
      const occ = memberOccurrences(f.doc, sym.name);
      if (occ.length) changes[f.uri] = occ.map((o) => TextEdit.replace(toRange(o.span), p.newName));
    }
    return { changes };
  }
  const edits = occurrences(doc, sym).map((o) => TextEdit.replace(toRange(o.span), p.newName));
  return { changes: { [p.textDocument.uri]: edits } };
});

// ------------------------------------------------------------------ symbols
connection.onDocumentSymbol((p): DocumentSymbol[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const out: DocumentSymbol[] = [];
  const lineRange = (l: number, e = l) => Range.create(l, 0, e, doc.lines[e]?.length ?? 0);
  for (const c of doc.classes) {
    const children = c.members.map((m) => DocumentSymbol.create(m.name, m.kind === 'function' ? m.signature + (m.label ? ' → ' + m.label : '') : (m.local ? 'local' : 'property'), m.kind === 'function' ? SymbolKind.Method : SymbolKind.Property, toRange(m.span), toRange(m.span)));
    out.push(DocumentSymbol.create(c.name, c.likes.length ? 'LIKE ' + c.likes.join(', ') : 'class', SymbolKind.Class, lineRange(c.span.line, Math.max(c.span.line, c.endLine)), toRange(c.nameSpan), children));
  }
  const labelBlocks = new Map(doc.blocks.filter((b) => b.kind === 'label').map((b) => [b.startLine, b.endLine]));
  for (const [, defs] of doc.labels) {
    const d = defs[0];
    const end = labelBlocks.get(d.span.line) ?? d.span.line;
    const cm = leadingComments(doc, d.span.line, 1)[0] ?? trailingComment(doc, d.span.line);
    out.push(DocumentSymbol.create(d.name, cm ?? 'label', SymbolKind.Function, lineRange(d.span.line, end), toRange(d.span)));
  }
  for (const [, f] of doc.fns) out.push(DocumentSymbol.create(f.name, `(${f.params.join(',')})`, SymbolKind.Function, lineRange(f.span.line, Math.max(f.span.line, f.endLine)), toRange(f.span)));
  out.sort((a, b) => a.range.start.line - b.range.start.line);
  return out;
});

connection.onWorkspaceSymbol((p): WorkspaceSymbol[] => {
  const q = p.query.toUpperCase();
  const out: WorkspaceSymbol[] = [];
  for (const f of index.allFiles()) {
    if (f.compiled) continue;
    for (const c of f.doc.classes) {
      if (c.name.toUpperCase().includes(q)) out.push({ name: c.name, kind: SymbolKind.Class, location: Location.create(f.uri, toRange(c.nameSpan)) });
      for (const m of c.members) if (!m.local && m.name.toUpperCase().includes(q)) out.push({ name: m.name, kind: m.kind === 'function' ? SymbolKind.Method : SymbolKind.Property, containerName: c.name, location: Location.create(f.uri, toRange(m.span)) });
    }
    for (const [k, defs] of f.doc.labels) if (k.includes(q)) out.push({ name: defs[0].name, kind: SymbolKind.Function, containerName: path.basename(f.fsPath), location: Location.create(f.uri, toRange(defs[0].span)) });
    for (const [k, fn] of f.doc.fns) if (k.includes(q)) out.push({ name: fn.name, kind: SymbolKind.Function, containerName: path.basename(f.fsPath), location: Location.create(f.uri, toRange(fn.span)) });
    if (out.length > 2000) break;
  }
  return out;
});

connection.onFoldingRanges((p): FoldingRange[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const out: FoldingRange[] = [];
  for (const b of doc.blocks) if (b.endLine > b.startLine) out.push({ startLine: b.startLine, endLine: b.kind === '{' || b.kind === 'label' ? b.endLine : b.endLine, kind: b.kind === 'label' ? FoldingRangeKind.Region : undefined });
  for (const c of doc.classes) if (c.endLine > c.span.line) out.push({ startLine: c.span.line, endLine: c.endLine });
  // runs of comment lines
  let start = -1;
  for (let l = 0; l <= doc.lines.length; l++) {
    const toks = l < doc.lines.length ? doc.lexed[l].tokens.filter((t) => t.kind !== T.LineNumber) : [];
    const isComment = toks.length > 0 && (toks[0].kind === T.Comment || toks[0].upper === 'REM');
    if (isComment && start < 0) start = l;
    if (!isComment && start >= 0) { if (l - 1 > start) out.push({ startLine: start, endLine: l - 1, kind: FoldingRangeKind.Comment }); start = -1; }
  }
  return out;
});

// ------------------------------------------------------------------ semantic tokens
connection.languages.semanticTokens.on((p) => {
  const doc = getDoc(p.textDocument.uri);
  const b = new SemanticTokensBuilder();
  if (!doc) return b.build();
  if (isPxts(p.textDocument.uri)) return pxtsSemanticTokens(doc, pxtsInfo(p.textDocument.uri)!, documents.get(p.textDocument.uri)?.getText() ?? '');
  const T_ = (n: string) => tokenTypes.indexOf(n);
  const M_ = (...ns: string[]) => ns.reduce((a, n) => a | (1 << tokenModifiers.indexOf(n)), 0);
  doc.lexed.forEach((lx, line) => {
    for (const t of lx.tokens) {
      let type = -1, mod = 0, start = t.start, len = t.end - t.start;
      switch (t.kind) {
        case T.Label: type = T_('label'); mod = M_('declaration'); break;
        case T.Mnemonic: type = T_('macro'); break;
        case T.Special: type = T_('enumMember'); mod = M_('defaultLibrary'); break;
        case T.Member: start += 1; len -= 1; type = t.role === 'method' ? T_('method') : T_('property'); break;
        case T.Number: if (t.role === 'lineRef') type = T_('label'); break;
        case T.String: if (t.role === 'className') type = T_('class'); break;
        case T.Word:
          switch (t.role) {
            case 'directive': case 'clause': type = T_('keyword'); break;
            case 'function': type = T_('function'); mod = M_('defaultLibrary'); break;
            case 'userFunction': type = T_('function'); break;
            case 'sysvar': type = T_('variable'); mod = M_('readonly', 'defaultLibrary'); break;
            case 'fileOption': type = T_('parameter'); mod = M_('defaultLibrary'); break;
            case 'labelRef': type = T_('label'); break;
            case 'labelDef': type = T_('label'); mod = M_('declaration'); break;
            case 'method': type = T_('method'); mod = M_('declaration'); break;
            case 'property': type = T_('property'); mod = M_('declaration'); break;
            case 'parameter': type = T_('parameter'); break;
            case 'globalVariable': type = T_('variable'); mod = M_('static'); break;
            case 'objectVariable': type = T_('variable'); break;
            case 'stringVariable': case 'variable': case 'integerVariable': type = T_('variable'); break;
          }
          break;
      }
      if (type >= 0 && len > 0) b.push(line, start, len, type, mod);
    }
  });
  return b.build();
});

function pxtsSemanticTokens(doc: ParsedDoc, info: PxtsInfo, tsText: string) {
  const tsLines = tsText.split(/\r?\n/);
  // the same name on both sides: rec::Name$ is rec.Name$, this.X is _OBJ'X, global.X is %X
  const sameName = (ts: string, pvx: string) => ts.replace(/::/g, '.').toUpperCase() === pvx.replace(/^['%]/, '').toUpperCase();
  const T_ = (n: string) => tokenTypes.indexOf(n);
  const M_ = (...ns: string[]) => ns.reduce((a, n) => a | (1 << tokenModifiers.indexOf(n)), 0);
  const out: { line: number; start: number; len: number; type: number; mod: number }[] = [];
  doc.lexed.forEach((lx, pl) => {
    for (const seg of info.mapper.segmentsOnPvxLine(pl)) {
      const t = lx.tokens.find((x) => x.start < seg.pc1 && x.end > seg.pc0 && x.kind !== T.Comment);
      if (!t) continue;
      // only tokens that are the same name in the .pxts text: generated pieces (FUNCTION, LABEL:, DROP OBJECT ...) are
      // anchored to other tokens there, and TS keywords are coloured by the grammar
      const tsTok = tsLines[seg.tl]?.slice(seg.tc0, seg.tc1) ?? '';
      if (t.kind === T.Word && (t.role === 'directive' || t.role === 'clause')) continue;
      if (!(t.kind === T.String ? tsTok.replace(/^["']|["']$/g, '') === t.text.replace(/^"|"$/g, '') : sameName(tsTok, t.text))) continue;
      let type = -1, mod = 0;
      if (t.kind === T.Label) { type = T_('label'); mod = M_('declaration'); }
      else if (t.kind === T.Member) type = t.role === 'method' ? T_('method') : T_('property');
      else if (t.kind === T.Mnemonic) type = T_('macro');
      else if (t.kind === T.Special) type = T_('enumMember');
      else if (t.kind === T.String && t.role === 'className') type = T_('class');
      else if (t.kind === T.Word) {
        switch (t.role) {
          case 'directive': case 'clause': type = T_('keyword'); break;
          case 'function': type = T_('function'); mod = M_('defaultLibrary'); break;
          case 'userFunction': type = T_('function'); break;
          case 'sysvar': type = T_('variable'); mod = M_('readonly', 'defaultLibrary'); break;
          case 'fileOption': type = T_('parameter'); mod = M_('defaultLibrary'); break;
          case 'labelRef': type = T_('label'); break;
          case 'method': type = T_('method'); mod = M_('declaration'); break;
          case 'property': type = T_('property'); mod = M_('declaration'); break;
          case 'parameter': type = T_('parameter'); break;
          case 'globalVariable': type = T_('variable'); mod = M_('static'); break;
          default: type = T_('variable');
        }
      }
      if (type >= 0) out.push({ line: seg.tl, start: seg.tc0, len: seg.tc1 - seg.tc0, type, mod });
    }
  });
  out.sort((a, b) => a.line - b.line || a.start - b.start);
  const b = new SemanticTokensBuilder();
  let last = { line: -1, end: -1 };
  for (const o of out) {
    if (o.line === last.line && o.start < last.end) continue;
    b.push(o.line, o.start, o.len, o.type, o.mod);
    last = { line: o.line, end: o.start + o.len };
  }
  return b.build();
}

// ------------------------------------------------------------------ formatting
connection.onDocumentFormatting((p) => {
  if (isPxts(p.textDocument.uri)) {
    // canonical .pxts layout: translate to ProvideX and back (only when the document parses cleanly)
    const td = documents.get(p.textDocument.uri);
    const info = pxtsInfo(p.textDocument.uri);
    if (!td || !info || info.res.problems.some((x) => x.severity !== 'warning')) return [];
    const formatted = toPxts(info.res.text).text;
    return formatted === td.getText() ? [] : [TextEdit.replace(Range.create(0, 0, td.lineCount, 0), formatted)];
  }
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  return formatDocumentFull(doc, { ...settings.format, useTabs: !p.options.insertSpaces, indentSize: settings.format.indentSize || p.options.tabSize });
});
connection.onDocumentRangeFormatting((p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  return formatDocumentFull(doc, { ...settings.format, useTabs: !p.options.insertSpaces, indentSize: settings.format.indentSize || p.options.tabSize }, p.range);
});

// ------------------------------------------------------------------ links
connection.onDocumentLinks((p): DocumentLink[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const out: DocumentLink[] = [];
  for (const l of doc.links) {
    const fp = index.locateProgram(l.target);
    if (fp) out.push({ range: Range.create(l.span.line, l.span.start + 1, l.span.line, l.span.end - 1), target: programUri(fp), tooltip: `${l.directive} ${fp}${l.entry ? ' at ' + l.entry : ''}` });
  }
  return out;
});

// ------------------------------------------------------------------ code actions
connection.onCodeAction((p): CodeAction[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const out: CodeAction[] = [];
  for (const d of p.context.diagnostics) {
    if (d.code === 'undefined-label' && d.data && typeof (d.data as { label?: string }).label === 'string') {
      const label = (d.data as { label: string }).label;
      const lastLine = doc.lines.length;
      const newText = (doc.numbered ? String(Math.max(0, ...doc.lineNumbers.keys()) + 10).padStart(4, '0') + ' ' : '') + `${label}:\n` + (doc.numbered ? String(Math.max(0, ...doc.lineNumbers.keys()) + 20).padStart(4, '0') + ' ' : '') + 'RETURN\n';
      out.push({ title: `Create label ${label}`, kind: CodeActionKind.QuickFix, diagnostics: [d], edit: { changes: { [p.textDocument.uri]: [TextEdit.insert(Position.create(lastLine, 0), (doc.lines[lastLine - 1] === '' ? '' : '\n') + newText)] } } });
      // suggest similarly named labels
      const close = [...doc.labels.values()].map((x) => x[0].name).filter((n) => similar(n, label)).slice(0, 3);
      for (const c of close) out.push({ title: `Change to ${c}`, kind: CodeActionKind.QuickFix, diagnostics: [d], isPreferred: true, edit: { changes: { [p.textDocument.uri]: [TextEdit.replace(d.range, c)] } } });
    }
  }
  // rewrite '?' into PRINT, uppercase keywords on the selected lines
  const edits: TextEdit[] = [];
  for (let l = p.range.start.line; l <= p.range.end.line; l++) {
    for (const t of doc.lexed[l]?.tokens ?? []) {
      if (t.kind === T.Operator && t.text === '?' && statementAt(doc, l, t.start)?.head === t) edits.push(TextEdit.replace(tokRange(l, t), 'PRINT'));
    }
  }
  if (edits.length) out.push({ title: 'Replace ? with PRINT', kind: CodeActionKind.RefactorRewrite, edit: { changes: { [p.textDocument.uri]: edits } } });
  return out;
});

function similar(a: string, b: string): boolean {
  a = a.toUpperCase(); b = b.toUpperCase();
  if (a === b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // Levenshtein <= 2
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length] <= 2;
}

// ------------------------------------------------------------------ call hierarchy (GOSUB / methods)
function labelAtLine(doc: ParsedDoc, line: number): string | undefined {
  let best: { name: string; line: number } | undefined;
  for (const [, defs] of doc.labels) for (const d of defs) if (d.span.line <= line && (!best || d.span.line > best.line)) best = { name: d.name, line: d.span.line };
  return best?.name;
}

function hierarchyItem(uri: string, doc: ParsedDoc, name: string): CallHierarchyItem | undefined {
  const d = labelDef(doc, name);
  if (!d) return undefined;
  const end = doc.blocks.find((b) => b.kind === 'label' && b.startLine === d.line)?.endLine ?? d.line;
  return { name, kind: SymbolKind.Function, uri, range: Range.create(d.line, 0, end, doc.lines[end]?.length ?? 0), selectionRange: toRange(d), detail: leadingComments(doc, d.line, 1)[0] };
}

connection.languages.callHierarchy.onPrepare((p) => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return null;
  const sym = symbolAt(doc, p.position.line, p.position.character);
  const name = sym?.kind === 'label' ? sym.name : labelAtLine(doc, p.position.line);
  const it = name ? hierarchyItem(p.textDocument.uri, doc, name) : undefined;
  return it ? [it] : null;
});

connection.languages.callHierarchy.onIncomingCalls((p): CallHierarchyIncomingCall[] => {
  const doc = getDoc(p.item.uri);
  if (!doc) return [];
  const key = p.item.name.toUpperCase();
  const byCaller = new Map<string, Range[]>();
  for (const r of doc.refs) {
    if (r.kind !== 'label' || r.target !== key) continue;
    const caller = labelAtLine(doc, r.line) ?? '(main)';
    const arr = byCaller.get(caller) ?? [];
    arr.push(tokRange(r.line, r.token));
    byCaller.set(caller, arr);
  }
  const out: CallHierarchyIncomingCall[] = [];
  for (const [caller, ranges] of byCaller) {
    const it = hierarchyItem(p.item.uri, doc, caller) ?? { name: caller, kind: SymbolKind.File, uri: p.item.uri, range: Range.create(0, 0, 0, 0), selectionRange: Range.create(0, 0, 0, 0) };
    out.push({ from: it, fromRanges: ranges });
  }
  return out;
});

connection.languages.callHierarchy.onOutgoingCalls((p): CallHierarchyOutgoingCall[] => {
  const doc = getDoc(p.item.uri);
  if (!doc) return [];
  const byTarget = new Map<string, Range[]>();
  for (const r of doc.refs) {
    if (r.kind !== 'label' || r.line < p.item.range.start.line || r.line > p.item.range.end.line) continue;
    const arr = byTarget.get(r.target) ?? [];
    arr.push(tokRange(r.line, r.token));
    byTarget.set(r.target, arr);
  }
  const out: CallHierarchyOutgoingCall[] = [];
  for (const [target, ranges] of byTarget) {
    const it = hierarchyItem(p.item.uri, doc, doc.labels.get(target)?.[0]?.name ?? target);
    if (it) out.push({ to: it, fromRanges: ranges });
  }
  return out;
});

// ------------------------------------------------------------------ code lens
connection.onCodeLens((p): CodeLens[] => {
  const doc = getDoc(p.textDocument.uri);
  if (!doc) return [];
  const counts = new Map<string, number>();
  for (const r of doc.refs) if (r.kind === 'label') counts.set(r.target, (counts.get(r.target) ?? 0) + 1);
  const out: CodeLens[] = [];
  for (const [k, defs] of doc.labels) {
    const n = counts.get(k) ?? 0;
    const d = defs[0];
    out.push({ range: toRange(d.span), command: { title: `${n} reference${n === 1 ? '' : 's'}`, command: n ? 'editor.action.findReferences' : '', arguments: n ? [p.textDocument.uri, Position.create(d.span.line, d.span.start)] : undefined } });
  }
  return out;
});

// ------------------------------------------------------------------ custom requests used by the client
connection.onRequest('providex/decompile', async (p: { path: string }) => {
  const r = await (await requireDevelopment('Decompiling a program')).list(p.path);
  return r.lines.map((l) => l.text);
});
function viewOptions(): ViewOptions {
  return { ...settings.readable, keywordCase: settings.format.keywordCase, indentSize: settings.format.indentSize || 2 };
}

// Readable view of a compiled program (no statement numbers, one statement per line, formatted).
connection.onRequest('providex/decompileView', async (p: { path: string }) => {
  const r = await (await requireDevelopment('Decompiling a program')).list(p.path, settings.readable.omitLet);
  const view = toView(r.lines.map((l) => l.text), viewOptions());
  return { text: view.text, base: view };
});

// Save a readable view: restore statement numbers (keeping the original ones) and compile.
connection.onRequest('providex/compileView', async (p: { text: string; out: string; base?: ViewResult }) => {
  const b = await requireDevelopment('Compiling');
  const back = fromView(p.text, p.base);
  const r = await b.compile(back.numbered.join('\n'), p.out);
  return {
    saved: r.saved, mergeError: r.mergeError, renumbered: back.renumbered,
    diagnostics: r.diagnostics.map((d) => ({ ...d, line: back.viewLine[d.line] ?? d.line })),
    base: r.saved ? back.base : p.base,
  };
});

// ProvideX <-> ProvideX/TS conversions
connection.onRequest('providex/toPxts', (p: { text: string }) => {
  // numbered or readable ProvideX -> .pxts
  const d = parse(p.text);
  const readable = d.numbered ? toView(d.lines.filter((l) => l.trim()), viewOptions()).text : p.text;
  return toPxts(readable).text;
});
connection.onRequest('providex/fromPxts', (p: { text: string }) => {
  const r = fromPxts(p.text);
  return { text: r.text, problems: r.problems };
});
connection.onRequest('providex/decompilePxts', async (p: { path: string }) => {
  const r = await (await requireDevelopment('Decompiling a program')).list(p.path, settings.readable.omitLet);
  const view = toView(r.lines.map((l) => l.text), viewOptions());
  return { text: toPxts(view.text).text, base: view };
});
connection.onRequest('providex/compilePxts', async (p: { text: string; out: string; base?: ViewResult }) => {
  const b = await requireDevelopment('Compiling');
  const tr = fromPxts(p.text);
  if (tr.problems.some((x) => x.severity !== 'warning')) return { saved: false, mergeError: null, diagnostics: tr.problems.map((x) => ({ line: x.line, message: x.message, code: 0, stmt: 0, text: '' })), base: p.base };
  const al = p.base ? alignToBase(tr.text, p.base.text) : { text: tr.text, from: undefined };
  const back = fromView(al.text, p.base);
  const r = await b.compile(back.numbered.join('\n'), p.out);
  return {
    saved: r.saved, mergeError: r.mergeError, renumbered: back.renumbered,
    diagnostics: r.diagnostics.map((d) => ({ ...d, line: tr.srcLine[((v) => al.from?.[v] ?? v)(back.viewLine[d.line] ?? d.line)] ?? 0 })),
    base: r.saved ? back.base : p.base,
  };
});

// Turn the current text into the readable form (used by "ProvideX: Make Readable").
connection.onRequest('providex/makeReadable', (p: { uri: string }) => {
  const doc = getDoc(p.uri);
  if (!doc) return null;
  const lines = doc.lines;
  const numbered = doc.numbered ? lines : lines.map((l, i) => (l.trim() ? String(i + 1).padStart(4, '0') + ' ' + l.trim() : l)).filter((l) => l.trim());
  return toView(numbered, viewOptions()).text;
});

connection.onRequest('providex/compile', async (p: { text: string; out: string; force?: boolean }) => {
  return (await requireDevelopment('Compiling')).compile(p.text, p.out, p.force);
});
connection.onRequest('providex/check', async (p: { text: string }) => {
  return (await requireDevelopment('Checking syntax with ProvideX')).check(p.text, true);
});
connection.onRequest('providex/evaluate', async (p: { expr: string }) => {
  await bridgeSettled();
  if (!bridge) throw new Error(licenceMessage('Evaluating an expression'));
  return bridge.evaluate(p.expr);
});
connection.onRequest('providex/status', async () => ({ bridge: !!bridge, home: currentHome(), development: isDevelopment(), files: index.allFiles().length, lastError: bridge?.lastError }));
connection.onRequest('providex/restartBridge', async () => { await setupBridge(true); return true; });

// Renumber statements (start/step) and rewrite numeric references.
connection.onRequest('providex/renumber', (p: { uri: string; start?: number; step?: number }) => {
  const doc = getDoc(p.uri);
  if (!doc) return [];
  const start = p.start ?? 10, step = p.step ?? 10;
  const map = new Map<number, number>();
  const edits: TextEdit[] = [];
  let n = start;
  const width = Math.max(4, String(start + step * doc.lines.length).length);
  for (let l = 0; l < doc.lines.length; l++) {
    const lx = doc.lexed[l];
    if (!lx.tokens.length && !doc.lines[l].trim()) continue;
    if (lx.lineNumber) map.set(parseInt(lx.lineNumber.text, 10), n);
    const txt = String(n).padStart(width, '0');
    if (lx.lineNumber) edits.push(TextEdit.replace(tokRange(l, lx.lineNumber), txt));
    else edits.push(TextEdit.insert(Position.create(l, 0), txt + ' '));
    n += step;
  }
  for (const r of doc.refs) {
    if (r.kind !== 'line') continue;
    const old = parseInt(r.target, 10);
    let target = map.get(old);
    if (target === undefined) { const nx = nextStatementNumber(doc, old); if (nx !== undefined) target = map.get(nx); }
    if (target !== undefined) edits.push(TextEdit.replace(tokRange(r.line, r.token), String(target).padStart(width, '0')));
  }
  return edits;
});

// Remove statement numbers; referenced numbers become labels (L0100:).
connection.onRequest('providex/stripLineNumbers', (p: { uri: string }) => {
  const doc = getDoc(p.uri);
  if (!doc) return [];
  const referenced = new Map<number, string>();
  for (const r of doc.refs) {
    if (r.kind !== 'line') continue;
    let n = parseInt(r.target, 10);
    if (!doc.lineNumbers.has(n)) { const nx = nextStatementNumber(doc, n); if (nx === undefined) continue; n = nx; }
    referenced.set(n, 'L' + String(n).padStart(4, '0'));
  }
  const edits: TextEdit[] = [];
  for (let l = 0; l < doc.lines.length; l++) {
    const lx = doc.lexed[l];
    if (!lx.lineNumber) continue;
    const n = parseInt(lx.lineNumber.text, 10);
    const endCol = lx.codeStart < doc.lines[l].length && doc.lines[l][lx.codeStart] === ' ' ? lx.codeStart + 1 : lx.codeStart;
    const label = referenced.get(n);
    edits.push(TextEdit.replace(Range.create(l, 0, l, Math.min(endCol + (doc.lines[l][lx.codeStart] === '?' ? 0 : 0), doc.lines[l].length)), label ? label + ':\n' : ''));
  }
  for (const r of doc.refs) {
    if (r.kind !== 'line') continue;
    let n = parseInt(r.target, 10);
    if (!doc.lineNumbers.has(n)) { const nx = nextStatementNumber(doc, n); if (nx === undefined) continue; n = nx; }
    const label = referenced.get(n);
    // IF x THEN 100  ->  IF x THEN GOTO L0100   (a bare label is not an implied GOTO)
    if (label) edits.push(TextEdit.replace(tokRange(r.line, r.token), r.context === 'THEN' ? 'GOTO ' + label : label));
  }
  return edits;
});

documents.listen(connection);
connection.listen();

process.on('exit', () => bridge?.killNow());
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { bridge?.killNow(); process.exit(0); });
void MarkupKind;
