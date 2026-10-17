import { describe, it, expect } from 'vitest';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
import { PxtsMapper } from '../server/src/pxts/mapper';
import { alignToBase } from '../server/src/pxts/align';

const ts = (pvx: string) => toPxts(pvx).text.trim();
const pvx = (src: string) => { const r = fromPxts(src); expect(r.problems).toEqual([]); return r.text.trim(); };

describe('ProvideX -> ProvideX/TS', () => {
  it('maps statements, members, operators and comments', () => {
    expect(ts("LET x$=coSession'FileObj'GetColumnInfo(\"A\",B$)'Length ! note")).toBe('x$ = coSession.FileObj.GetColumnInfo("A", B$).Length;  // note');
    expect(ts('IF A=1 AND B<>2 OR NOT(C) THEN GOTO DONE')).toBe('if (A == 1 && B != 2 || !C) goto DONE;');
    expect(ts('X=_OBJ\'Count; Y$=$0D0A$+"a""b"')).toBe('X = this.Count;\nY$ = "\\x0D\\x0A" + "a\\"b";');
    expect(ts('READ (1,KEY=K$,ERR=*NEXT)A$')).toBe('read({ ch: 1, key: K$, err: *NEXT }, A$);');
    expect(ts('addressLink.CustomerNo$="1"')).toBe('addressLink::CustomerNo$ = "1";');
  });
  it('maps blocks', () => {
    const src = ['FOR I=1 TO 10 STEP 2', 'IF I=3 THEN {', 'CONTINUE', '} ELSE IF I=5 THEN {', 'BREAK', '} ELSE {', 'PRINT I', '}', 'NEXT I', 'WHILE X<3', 'X=X+1', 'WEND', 'SWITCH X', 'CASE 1,2', 'BREAK', 'DEFAULT', 'END SWITCH'].join('\n');
    expect(ts(src)).toBe([
      'for (I = 1; I <= 10; I += 2) {', '  if (I == 3) {', '    continue;', '  } else if (I == 5) {', '    break;', '  } else {', '    print(I);', '  }', '}',
      'while (X < 3) {', '  X = X + 1;', '}', 'switch (X) {', 'case 1: case 2:', '  break;', 'default:', '}',
    ].join('\n'));
  });
  it('keeps every statement after ELSE conditional', () => {
    // ProvideX: everything after ELSE up to the end of the line is conditional
    expect(ts('IF A THEN {\nX=1\n} ELSE R=1; Q=2')).toContain('} else { R = 1; Q = 2; }');
    expect(pvx('if (A) {\n  X = 1\n} else { R = 1; Q = 2; }')).toBe('IF A THEN {\nX = 1\n} ELSE R = 1; Q = 2');
  });
  it('keeps unstructured loops verbatim', () => {
    expect(ts('FOR I=1 TO 3\nIF I=2 THEN GOTO OUT\nOUT:\nNEXT I\nNEXT I')).toContain('pvx`NEXT I`');
  });
  it('maps classes', () => {
    const src = ['DEF CLASS "My_Bus" CREATE REQUIRED', 'LIKE "SY_Maint"', 'PROPERTY Name$ GET GET_NAME SET ERR', 'LOCAL cCount=0', 'FUNCTION Run(a$)RUN_IT', 'END DEF'].join('\n');
    expect(ts(src)).toBe(['@create(required)', 'class My_Bus extends SY_Maint {', '  @get(GET_NAME) readonly Name$;', '  private cCount = 0;', '  Run(a$) => RUN_IT;', '}'].join('\n'));
    expect(pvx(ts(src))).toBe(['DEF CLASS "My_Bus" CREATE REQUIRED', 'LIKE "SY_Maint"', 'PROPERTY Name$ GET GET_NAME SET ERR', 'LOCAL cCount = 0', 'FUNCTION Run(a$)RUN_IT', 'END DEF'].join('\n'));
  });
});

describe('ProvideX/TS -> ProvideX', () => {
  it('translates expressions and statements', () => {
    expect(pvx('x$ = coSession.FileObj.GetColumnInfo("A", B$).Length // n')).toBe("x$ = coSession'FileObj'GetColumnInfo(\"A\", B$)'Length ! n");
    expect(pvx('if (a == 1 && !done) goto L')).toBe('IF a = 1 AND  NOT(done) THEN GOTO L');
    expect(pvx('s$ = "a\\"b" + "\\xFE"')).toBe('s$ = "a""b" + $FE$');
    expect(pvx('rec::name$ = this.Name$')).toBe("rec.name$ = _OBJ'Name$");
    expect(pvx('pvx`PRINT \'CS\'`')).toBe("PRINT 'CS'");
  });
  it('lowers functions to DEF FN with LOCAL scope', () => {
    const out = pvx('function add(a, b) {\n  let c = a + b\n  return c\n}\nx = add(1, 2)');
    expect(out).toContain('DEF FN_add(px_add.a,px_add.b) ! @pxts function');
    expect(out).toContain('LOCAL a,b,c ! @pxts locals');
    expect(out).toContain('a=px_add.a; b=px_add.b ! @pxts params');
    expect(out).toContain('x = FN_add(1, 2)');
  });
  it('lowers return inside loops to a flag and BREAK', () => {
    const out = pvx('function f(n) {\n  let i\n  for (i = 1 to 9) {\n    if (i > n) return i\n  }\n  return 0\n}');
    expect(out).toContain('IF i > n THEN px_f.ret=i; px_f.done=1; BREAK ! @pxts return');
    expect(out).toContain('IF px_f.done THEN RETURN px_f.ret ! @pxts loopret');
  });
  it('round-trips functions back to the TS form', () => {
    const src = 'function f$(s$) {\n  let o$ = ""\n  return o$ + s$\n}';
    expect(ts(pvx(src))).toBe('function f$(s$) {\n  let o$ = "";\n  return o$ + s$;\n}');
  });
  it('supports both TRY forms', () => {
    expect(pvx('try {\n  x = 1\n} catch {\n  x = 2\n}')).toBe('TRY\nx = 1\nCATCH\nx = 2\nEND_TRY');
    expect(pvx('try {\n  x = 1\n}\ncatch {\n  x = 2\n}')).toBe('TRY {\nx = 1\n}\nCATCH {\nx = 2\n}');
  });
  it('translates classes with method bodies', () => {
    const src = ['@create(required)', 'class Bus extends SY_Common {', '  private coSession;', '  constructor(coSession) {', '    return;', '  }', '  SetUIHandle(ui, x?) {', '    coUI = ui;', '    return;', '  }', '  Item(n) { return n * 2; }', '}'].join('\n');
    expect(pvx(src)).toBe(['DEF CLASS "Bus" CREATE REQUIRED', 'LIKE "SY_Common"', 'LOCAL coSession', 'FUNCTION SetUIHandle(ui,x)SET_UI_HANDLE', 'FUNCTION Item(n)=n * 2', 'END DEF', 'ON_CREATE:', 'ENTER coSession', 'RETURN', 'SET_UI_HANDLE:', 'ENTER ui,x,ERR=*NEXT', 'coUI = ui', 'RETURN'].join('\n'));
  });
  it('translates TS-style statements back', () => {
    expect(pvx('for (i = 1; i <= n; i++) {\n  x = i\n}')).toBe('FOR i=1 TO n\nx = i\nNEXT i');
    expect(pvx('for (i = 9; i >= 1; i -= 2) {\n}')).toBe('FOR i=9 TO 1 STEP -2\nNEXT i');
    expect(pvx('read({ ch: f, key: k$, err: *NEXT }, a$, b)')).toBe('READ (f,KEY=k$,ERR=*NEXT)a$, b');
    expect(pvx('dropObject(o, { err: *NEXT })')).toBe('DROP OBJECT o,ERR=*NEXT');
    expect(pvx('x = this.Open(a$, { err: *NEXT })')).toBe("x = _OBJ'Open(a$,ERR=*NEXT)");
    expect(pvx('o = new SY_Thing(a, b)')).toBe('o = NEW("SY_Thing", a, b)');
    expect(pvx('global.Sys = 1')).toBe('%Sys = 1');
    expect(pvx('const FNX = (A) => A + 1;')).toBe('DEF FNX(A)=A + 1');
    expect(pvx('switch (x) {\ncase 1: case 2:\n  break;\n}')).toContain('CASE 1,2');
  });
  it('reports syntax problems with positions', () => {
    const r = fromPxts('for (i = 1 10) {\n}');
    expect(r.problems[0]).toMatchObject({ line: 0, message: 'Expected "to"' });
  });
  it('maps positions between the two texts', () => {
    const r = fromPxts('x$ = ucs(a$) + b.Name$');
    const m = new PxtsMapper(r);
    const ucsTs = { line: 0, character: 5 };
    const p = m.toPvx(ucsTs);
    expect(r.text.split('\n')[p.line].slice(p.character, p.character + 3)).toBe('ucs');
    expect(m.toTs(p)).toEqual(ucsTs);
  });
});

describe('saving ProvideX/TS over an existing program', () => {
  it('restores the class layout and spellings of an unchanged program', () => {
    const base = [
      'DEF CLASS "Bus" CREATE REQUIRED', '  ! Inherits', '  LIKE "SY_Common", "SY_Open"', '  LOCAL coSession', '  ! Public', '  FUNCTION Run(a$) RUN',
      '  ! Private', '  FUNCTION LOCAL Check() CHECK', 'END DEF', 'ON_CREATE:', 'ENTER coSession', 'RETURN', '! private methods', 'CHECK:', 'IF (x) THEN LET y = $$', 'RETURN 1', 'RUN:', 'ENTER a$', 'RETURN',
    ].join('\n');
    const back = fromPxts(toPxts(base).text);
    expect(back.problems).toEqual([]);
    expect(back.text).not.toBe(base);
    expect(alignToBase(back.text, base).text).toBe(base);
  });
  it('keeps edits and new declarations in the header', () => {
    const base = ['DEF CLASS "Bus"', '  FUNCTION B() B', '  FUNCTION A() A', 'END DEF', 'A:', 'RETURN', 'B:', 'RETURN'].join('\n');
    const ts2 = toPxts(base).text.replace('class Bus {', 'class Bus {\n  public Extra;');
    const out = alignToBase(fromPxts(ts2).text, base).text.split('\n');
    expect(out.indexOf('PROPERTY Extra')).toBeGreaterThan(0);
    expect(out.indexOf('PROPERTY Extra')).toBeLessThan(out.findIndex((l) => l.startsWith('END DEF')));
    expect(out.findIndex((l) => l.includes('FUNCTION B()'))).toBeLessThan(out.findIndex((l) => l.includes('FUNCTION A()')));
  });
});