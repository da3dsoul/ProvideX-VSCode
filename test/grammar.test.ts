import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

let grammar: vsctm.IGrammar;

beforeAll(async () => {
  const wasm = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
    loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'providex.tmLanguage.json'), 'utf8'), 'providex.tmLanguage.json'),
  });
  grammar = (await registry.loadGrammar('source.providex'))!;
});

function scopesOf(line: string): [string, string][] {
  const r = grammar.tokenizeLine(line, vsctm.INITIAL);
  return r.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1]]);
}
function scopeAt(line: string, text: string): string | undefined {
  return scopesOf(line).find(([t]) => t === text)?.[1];
}

describe('TextMate grammar', () => {
  it('highlights statement numbers, labels and comments', () => {
    expect(scopeAt('0010 PRINT "hi" ! say hi', '0010')).toBe('constant.numeric.line-number.providex');
    expect(scopeAt('0010 PRINT "hi" ! say hi', '! say hi')).toBe('comment.line.exclamation.providex');
    expect(scopeAt('ON_CREATE:', 'ON_CREATE')).toBe('entity.name.label.providex');
    expect(scopeAt('0044 ON_CREATE:', 'ON_CREATE')).toBe('entity.name.label.providex');
    expect(scopeAt('0010 REM this is a comment', ' this is a comment')).toBe('comment.line.rem.providex');
  });
  it('distinguishes functions, directives, system variables and variables', () => {
    const line = '0020 LET X$=SUB(A$,"a","b"); PRINT ERR,TIM, cnt';
    expect(scopeAt(line, 'LET')).toBe('keyword.other.directive.providex');
    expect(scopeAt(line, 'SUB')).toBe('support.function.builtin.providex');
    expect(scopeAt(line, 'X$')).toBe('variable.other.string.providex');
    expect(scopeAt(line, 'ERR')).toBe('variable.language.system.providex');
    expect(scopeAt(line, 'cnt')).toBe('variable.other.providex');
  });
  it('handles mnemonics vs object members', () => {
    expect(scopeAt("PRINT 'CS','BR',\"x\",'ER'", "'CS'")).toBe('constant.other.mnemonic.providex');
    expect(scopeAt("LET x=coSession'FileObj'GetColumnInfo(\"A\")'Length", 'GetColumnInfo')).toBe('entity.name.function.member.providex');
    expect(scopeAt("LET x=coSession'FileObj'GetColumnInfo(\"A\")'Length", 'Length')).toBe('variable.other.property.providex');
  });
  it('handles options, special targets and hex strings', () => {
    const line = 'READ (1,KEY=K$,ERR=*NEXT,DOM=0100)R$; X$=$0D0A$';
    expect(scopeAt(line, 'ERR')).toBe('keyword.other.option.providex');
    expect(scopeAt(line, '*NEXT')).toBe('constant.language.special-target.providex');
    expect(scopeAt(line, '$0D0A$')).toBe('constant.other.hex-string.providex');
  });
  it('handles strings with doubled quotes', () => {
    const toks = scopesOf('PRINT "say ""hi"" now"');
    expect(toks.filter(([, s]) => s === 'constant.character.escape.providex').length).toBe(2);
  });
  it('tokenizes a corpus sample without errors', () => {
    const corpus = process.env.PVX_CORPUS;
    if (!corpus || !fs.existsSync(corpus)) return;
    let n = 0;
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (n < 50) { n++; for (const l of fs.readFileSync(p, 'latin1').split(/\r?\n/)) grammar.tokenizeLine(l, vsctm.INITIAL); } } };
    walk(corpus);
    expect(n).toBeGreaterThan(0);
  });
});

describe('ProvideX/TS grammar', () => {
  let ts: vsctm.IGrammar;
  beforeAll(async () => {
    const files: Record<string, string> = { 'source.pxts': 'pxts.tmLanguage.json', 'source.providex': 'providex.tmLanguage.json' };
    const registry = new vsctm.Registry({
      onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
      loadGrammar: async (scope) => (files[scope] ? vsctm.parseRawGrammar(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', files[scope]), 'utf8'), files[scope]) : null),
    });
    ts = (await registry.loadGrammar('source.pxts'))!;
  });
  const lines = (text: string) => {
    let st = vsctm.INITIAL;
    return text.split('\n').map((line) => { const r = ts.tokenizeLine(line, st); st = r.ruleStack; return r.tokens.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1]] as [string, string]); });
  };
  const at = (toks: [string, string][], text: string) => toks.find(([t]) => t === text)?.[1];
  it('keeps raw ProvideX inside its backticks', () => {
    const l = lines('pvx`REM note`; x = 1;\ny = 2;\npvx`PRINT "open`;\nz = 3;');
    expect(at(l[0], 'REM')).toBe('keyword.other.rem.providex');
    expect(at(l[0], 'x')).toBe('variable.other.pxts');
    expect(at(l[1], 'y')).toBe('variable.other.pxts');
    expect(at(l[3], 'z')).toBe('variable.other.pxts');
  });
  it('highlights classes, accessors and new', () => {
    const l = lines('class A extends B, C {\n  get Name$() {\n  }\n}\no = new SY_Thing(a); p = new(x$); set = 1;');
    expect(at(l[0], 'B')).toBe('entity.other.inherited-class.pxts');
    expect(at(l[1], 'get')).toBe('storage.type.accessor.pxts');
    expect(at(l[4], 'SY_Thing')).toBe('entity.name.type.class.pxts');
    expect(at(l[4], 'set')).toBe('variable.other.pxts');
  });
});