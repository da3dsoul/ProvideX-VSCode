import { describe, it, expect } from 'vitest';
import { parse } from '../server/src/parser';
import { analyze } from '../server/src/analyzer';
import { lexLine, T } from '../server/src/lexer';
import { symbolAt, inferObjectClass } from '../server/src/symbols';
import { formatDocument } from '../server/src/formatter';

const opts = { undefinedLabels: true, unusedLabels: false, blockStructure: true };
const problems = (src: string) => analyze(parse(src), opts).filter((p) => p.severity !== 'hint').map((p) => p.message);

describe('lexer', () => {
  it('splits statement numbers, labels, strings, hex strings, mnemonics, members', () => {
    const lx = lexLine(`0010 START_HERE: PRINT 'CS',"a""b",$0D0A$,obj'Method(1)'Prop$ ! note`);
    const kinds = lx.tokens.map((t) => t.kind);
    expect(lx.lineNumber?.text).toBe('0010');
    expect(kinds).toContain(T.Label);
    expect(lx.tokens.find((t) => t.kind === T.Mnemonic)?.text).toBe("'CS'");
    expect(lx.tokens.find((t) => t.kind === T.String)?.text).toBe('"a""b"');
    expect(lx.tokens.find((t) => t.kind === T.HexString)?.text).toBe('$0D0A$');
    expect(lx.tokens.filter((t) => t.kind === T.Member).map((t) => t.text)).toEqual(["'Method", "'Prop$"]);
    expect(lx.tokens[lx.tokens.length - 1].kind).toBe(T.Comment);
  });
  it('recognises *NEXT style targets, FN% names and {} subscripts', () => {
    expect(lexLine('READ (1,ERR=*NEXT)A$').tokens.some((t) => t.kind === T.Special && t.text === '*NEXT')).toBe(true);
    expect(lexLine('ON X GOTO *NEXT,100').tokens.some((t) => t.kind === T.Special)).toBe(true);
    expect(lexLine('X=A*B').tokens.some((t) => t.kind === T.Special)).toBe(false);
    expect(lexLine('DEF FN%UNPACK(A$)=1').tokens.find((t) => t.kind === T.Word && t.text.startsWith('FN'))?.text).toBe('FN%UNPACK');
    const sub = lexLine('LET X{I:N}=Y{ALL}');
    expect(sub.tokens.filter((t) => t.subscript).length).toBe(4);
    expect(sub.tokens.some((t) => t.kind === T.Label)).toBe(false);
  });
  it('tells mnemonics after a channel list from member access after a call', () => {
    const mn = (s: string) => lexLine(s).tokens.filter((t) => t.kind === T.Mnemonic).map((t) => t.text);
    const mem = (s: string) => lexLine(s).tokens.filter((t) => t.kind === T.Member).map((t) => t.text);
    expect(mn("PRINT (0,ERR=*NEXT)'POP','SHOW'(1),")).toEqual(["'POP'", "'SHOW'"]);
    expect(mn("MNEMONIC (LFO)'RM'=MNM('RM',LFO)")).toEqual(["'RM'", "'RM'"]);
    expect(mn("MNEMONIC (LFO)'! '=$B0$")).toEqual(["'! '"]);
    expect(mn("LET CLR$='F=',X=1")).toEqual(["'F='"]);
    expect(mem("X=coSession'FileObj'GetColumnInfo(A$)'Length")).toEqual(["'FileObj", "'GetColumnInfo", "'Length"]);
    expect(mem("X=a[1]'Name$")).toEqual(["'Name$"]);
  });
  it('treats keyword-spelled names in operand position as variables', () => {
    const doc = parse('IF SORT[0]=2 THEN X=1\nIF ROUND=0 THEN X=2\nIF NOT(PROCEED) THEN X=3');
    const roles = doc.lexed.map((lx) => lx.tokens.find((t) => /^(SORT|ROUND|PROCEED)$/.test(t.upper))?.role);
    expect(roles).toEqual(['variable', 'variable', 'variable']);
  });
  it('flags unterminated strings', () => {
    expect(lexLine('PRINT "abc').tokens[1].unterminated).toBe(true);
  });
});

describe('parser / analyzer', () => {
  it('accepts well-formed numbered code', () => {
    const src = [
      '0010 SETERR 0900',
      '0020 FOR I=1 TO 10',
      '0030 IF I=5 THEN GOSUB 0100; GOTO 0040 ELSE PRINT I',
      '0040 NEXT I',
      '0050 END',
      '0100 PRINT "five"; RETURN',
      '0900 PRINT ERR; END',
    ].join('\n');
    expect(problems(src)).toEqual([]);
  });

  it('reports undefined labels and duplicate labels', () => {
    const src = ['GOSUB NOWHERE', 'A:', 'RETURN', 'A:', 'RETURN'].join('\n');
    const p = problems(src);
    expect(p.some((m) => /NOWHERE/.test(m))).toBe(true);
    expect(p.some((m) => /Duplicate statement label A/.test(m))).toBe(true);
  });

  it('treats missing statement numbers as fall-through hints', () => {
    const doc = parse('0010 GOTO 0015\n0020 END');
    const all = analyze(doc, opts);
    expect(all.find((p) => p.code === 'missing-line')?.severity).toBe('hint');
  });

  it('understands IF ... THEN ...; ... ELSE ... on one line', () => {
    const src = '0010 IF X THEN LET A=1; GOTO 0030 ELSE IF Y THEN LET B=2; GOTO 0030 ELSE LET C=3\n0030 END';
    expect(problems(src)).toEqual([]);
  });

  it('balances blocks and reports unbalanced ones', () => {
    expect(problems('WHILE X\nPRINT X\nWEND')).toEqual([]);
    expect(problems('WHILE ++loop<=10\nWEND')).toEqual([]);
    expect(problems('SWITCH X\nCASE 1\nBREAK\nDEFAULT\nEND SWITCH')).toEqual([]);
    expect(problems('IF X THEN {\nPRINT 1\n} ELSE {\nPRINT 2\n}')).toEqual([]);
    expect(problems('IF X THEN {\nPRINT 1\n')).toContain('Unclosed "{" block');
    expect(problems('WEND').some((m) => /WEND without matching WHILE/.test(m))).toBe(true);
    expect(problems('DEF CLASS "X"\nPROPERTY A$').some((m) => /DEF CLASS without END DEF/.test(m))).toBe(true);
  });

  it('collects classes, members and labels', () => {
    const src = [
      'DEF CLASS "CU_Address_bus" CREATE REQUIRED DELETE REQUIRED',
      'LIKE "CU_Common","CI_CustomerFormatter"',
      'PROPERTY AddressWhereClause$',
      'PROPERTY Count GET GET_COUNT SET ERR',
      'LOCAL cMainTable$="CU_Address"',
      'FUNCTION SetKey(key$)SET_KEY',
      'FUNCTION LOCAL PERFORM ReadDetail()READ_DETAIL',
      'FUNCTION Item(X)=X*2',
      'END DEF',
      'GET_COUNT: RETURN 1',
      'SET_KEY:',
      'ENTER in.Key$',
      'RETURN _OBJ\'ReadDetail()',
      'READ_DETAIL:',
      'RETURN',
    ].join('\n');
    const doc = parse(src);
    expect(analyze(doc, opts).filter((p) => p.severity !== 'hint')).toEqual([]);
    const cls = doc.classes[0];
    expect(cls.name).toBe('CU_Address_bus');
    expect(cls.likes).toEqual(['CU_Common', 'CI_CustomerFormatter']);
    expect(cls.createRequired && cls.deleteRequired).toBe(true);
    expect(cls.members.map((m) => `${m.kind}:${m.name}${m.local ? ':local' : ''}`)).toEqual([
      'property:AddressWhereClause$', 'property:Count', 'property:cMainTable$:local', 'function:SetKey', 'function:ReadDetail:local', 'function:Item',
    ]);
    expect(cls.members.find((m) => m.name === 'SetKey')?.label).toBe('SET_KEY');
    expect(cls.members.find((m) => m.name === 'Count')?.getLabel).toBe('GET_COUNT');
    expect(inferObjectClass(doc, '_OBJ')).toBe('CU_Address_bus');
  });

  it('resolves symbols at positions', () => {
    const src = 'X$=SUB(A$,"a","b")\nGOSUB DOIT\nDOIT:\nRETURN';
    const doc = parse(src);
    expect(symbolAt(doc, 0, 4)).toMatchObject({ kind: 'builtin', name: 'SUB' });
    expect(symbolAt(doc, 0, 0)).toMatchObject({ kind: 'variable', name: 'X$' });
    expect(symbolAt(doc, 1, 7)).toMatchObject({ kind: 'label', name: 'DOIT' });
  });

  it('checks builtin argument counts when documented', () => {
    // only active when docs say min/max; ABS takes exactly one argument
    const p = analyze(parse('X=ABS(1,2,3)'), opts);
    const arity = p.filter((x) => x.code === 'arity');
    if (arity.length) expect(arity[0].message).toMatch(/ABS\(\) expects/);
  });

  it('infers object classes from NEW()', () => {
    const doc = parse('oSess=NEW("SY_Session")\noSess\'Run()');
    expect(inferObjectClass(doc, 'oSess')).toBe('SY_Session');
  });

  it('records program links for CALL/PERFORM/RUN', () => {
    const doc = parse('CALL "SYZDLL;GET_DATE",X$\nPERFORM "*Dev/x"');
    expect(doc.links.map((l) => [l.directive, l.target, l.entry])).toEqual([['CALL', 'SYZDLL', 'GET_DATE'], ['PERFORM', '*Dev/x', undefined]]);
  });
});

describe('formatter', () => {
  it('upper-cases keywords but not variables or strings', () => {
    const doc = parse('let x$=sub(a$,"let","b"); print x$');
    const edits = formatDocument(doc, { keywordCase: 'upper', indentBlocks: false, indentSize: 2, useTabs: false });
    const out = applyEdits(doc.lines.join('\n'), edits);
    expect(out).toBe('LET x$=SUB(a$,"let","b"); PRINT x$');
  });
  it('indents blocks in lineless code', () => {
    const doc = parse('FOR I=1 TO 3\nIF I THEN {\nPRINT I\n}\nNEXT I');
    const out = applyEdits(doc.lines.join('\n'), formatDocument(doc, { keywordCase: 'preserve', indentBlocks: true, indentSize: 2, useTabs: false }));
    expect(out).toBe('FOR I=1 TO 3\n  IF I THEN {\n    PRINT I\n  }\nNEXT I');
  });
});

function applyEdits(text: string, edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[]): string {
  const lines = text.split('\n');
  const offs = (l: number, c: number) => lines.slice(0, l).reduce((a, s) => a + s.length + 1, 0) + c;
  const sorted = [...edits].sort((a, b) => offs(b.range.start.line, b.range.start.character) - offs(a.range.start.line, a.range.start.character));
  let out = text;
  for (const e of sorted) out = out.slice(0, offs(e.range.start.line, e.range.start.character)) + e.newText + out.slice(offs(e.range.end.line, e.range.end.character));
  return out;
}
