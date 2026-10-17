// Language tables. lexicon.json is extracted from the installed ProvideX lexer table (Lib/_lexdef.en);
// the docs/*.json files add signatures and descriptions.
import * as fs from 'fs';
import * as path from 'path';

/** Directory holding the JSON data files (dist/../data when bundled, server/src/../../data in tests). */
function dataDir(): string {
  const cands = [path.join(__dirname, '..', 'data'), path.join(__dirname, '..', '..', 'data')];
  for (const c of cands) if (fs.existsSync(path.join(c, 'lexicon.json'))) return c;
  return cands[0];
}
const DATA = dataDir();
function readJson<T>(rel: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8')) as T; } catch { return fallback; }
}
const lexiconJson = readJson('lexicon.json', { directives: [], functions: [], systemVariables: [], mnemonics: [], fileOptions: [], operators: [], aliases: {} });
const errorsJson = readJson('errors.json', {});
const paramsJson = readJson('params.json', {});

export interface ParamDoc { name: string; doc?: string }
export interface SignatureDoc { label: string; params: ParamDoc[]; minArgs?: number; maxArgs?: number | null; doc?: string }
export interface FunctionDoc { category?: string; returns?: 'string' | 'number' | 'any'; doc?: string; signatures?: SignatureDoc[]; options?: string[]; unverified?: boolean }
export interface DirectiveDoc { category?: string; syntax?: string[]; doc?: string; block?: string; examples?: string[] }
export interface SysVarDoc { returns?: 'string' | 'number' | 'any'; doc?: string; unverified?: boolean }
export interface ParamInfo { title?: string; doc?: string; min?: string; max?: string; default?: string; onOff?: boolean; unverified?: boolean }

interface Lexicon {
  directives: string[];
  functions: string[];
  systemVariables: string[];
  mnemonics: string[];
  fileOptions: string[];
  operators: string[];
  aliases: Record<string, string>;
}

const lex = lexiconJson as unknown as Lexicon;

export const functionDocs: Record<string, FunctionDoc> = readJson('docs/functions.json', {});
export const directiveDocs: Record<string, DirectiveDoc> = readJson('docs/directives.json', {});
export const sysvarDocs: Record<string, SysVarDoc> = readJson('docs/sysvars.json', {});
const optionsRaw: Record<string, unknown> = readJson('docs/options.json', {});
export const mnemonicDocs: Record<string, string> = readJson('docs/mnemonics.json', {});
const paramsExt: Record<string, ParamInfo> = readJson('docs/params.json', {});

export const optionDocs: Record<string, string> = {};
export const specialTargetDocs: Record<string, string> = {};
for (const [k, v] of Object.entries(optionsRaw)) {
  if (k === '*specials' && v && typeof v === 'object') Object.assign(specialTargetDocs, v);
  else if (typeof v === 'string') optionDocs[k.replace(/=$/, '')] = v;
  else if (v && typeof v === 'object' && 'doc' in (v as object)) optionDocs[k.replace(/=$/, '')] = String((v as { doc: unknown }).doc);
}

export const errorMessages: Record<string, { kind: string; text: string }> = errorsJson as Record<string, { kind: string; text: string }>;
export const systemParams: Record<string, ParamInfo> = { ...(paramsJson as Record<string, ParamInfo>), ...paramsExt };
for (const [k, v] of Object.entries(paramsJson as Record<string, ParamInfo>)) {
  if (systemParams[k] && !systemParams[k].doc) systemParams[k] = { ...v, ...systemParams[k], doc: v.doc };
}

// Directives that are spelled with a space in the lexicon (END SWITCH) are matched as two words by the lexer.
export const DIRECTIVES = new Set<string>([...lex.directives.filter((d) => !d.includes(' ')), ...Object.keys(directiveDocs).filter((d) => /^[A-Z_]+$/.test(d))]);
export const FUNCTIONS = new Set<string>([...lex.functions, ...Object.keys(functionDocs)]);
export const SYSVARS = new Set<string>([...lex.systemVariables, ...Object.keys(sysvarDocs).filter((s) => /^[A-Z_]+$/.test(s))]);
export const MNEMONICS = new Set<string>([...lex.mnemonics, ...Object.keys(mnemonicDocs)]);
export const FILE_OPTIONS = new Set<string>([...lex.fileOptions, 'IOL', 'LEN', ...Object.keys(optionDocs).filter((o) => /^[A-Z]{3}$/.test(o))]);
export const ALIASES = lex.aliases;

// Words that are part of statement syntax rather than starting a statement.
export const CLAUSE_WORDS = new Set([
  'THEN', 'ELSE', 'TO', 'STEP', 'FROM', 'WHERE', 'BEGIN', 'END', 'RECORD', 'AND', 'OR', 'NOT', 'IOL', 'GET', 'SET',
  'REQUIRED', 'CREATE', 'DELETE', 'LOCAL', 'PERFORM', 'OBJECT', 'CONTROL', 'ON', 'OFF', 'VIA', 'LIKE', 'DATA', 'KEY', 'SAME',
  'EXCEPT', 'INDEX', 'UNIQUE', 'STATIC', 'GOTO', 'GOSUB', 'WITH', 'ALL',
]);

// Statement kinds whose arguments are statement references (labels / statement numbers).
export const BRANCH_DIRECTIVES = new Set(['GOTO', 'GOSUB', 'SETERR', 'SETESC', 'EXITTO', 'RETRY']);

export const BLOCK_OPENERS: Record<string, string> = { FOR: 'NEXT', WHILE: 'WEND', REPEAT: 'UNTIL', SWITCH: 'END SWITCH', TRY: 'END_TRY' };

export function functionDoc(name: string): FunctionDoc | undefined {
  return functionDocs[name.toUpperCase()];
}

export function isKnownFunction(name: string): boolean {
  return FUNCTIONS.has(name.toUpperCase());
}
