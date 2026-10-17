import { describe, it, expect } from 'vitest';
import { toView, fromView, defaultViewOptions } from '../server/src/view';
import { respaceLine } from '../server/src/formatter';

const prog = [
  '0010 LET R$="", X=0',
  '0020 IF X=0 THEN LET R$=R$+"a"; GOTO 0040 ELSE GOTO 0050',
  '0030 PRINT "never"',
  '0040 FOR I=1 TO 3; LET R$=R$+STR(I); NEXT I',
  '0050 READ (1,KEY=K$,ERR=0045,DOM=*NEXT)A$',
  '0060 DONE: END',
];

describe('readable view', () => {
  const view = toView(prog);
  const lines = view.text.split('\n');

  it('hides statement numbers and turns jump targets into labels', () => {
    expect(view.text).not.toMatch(/^\s*\d{4}\s/m);
    expect(lines).toContain('L0040:');
    expect(lines).toContain('L0050:');
    expect(view.text).toContain('GOTO L0040');
    // ERR=0045 does not exist: control passes to 0050
    expect(view.text).toContain('ERR=L0050');
    expect(view.text).toContain('DOM=*NEXT');
  });

  it('puts one statement per line and expands IF/ELSE into blocks', () => {
    expect(lines).toContain('IF X = 0 THEN {');
    expect(lines).toContain('} ELSE {');
    expect(lines.filter((l) => /^\s*NEXT I$/.test(l)).length).toBe(1);
  });

  it('indents blocks and spaces operators', () => {
    expect(lines).toContain('  LET R$ = R$ + "a"');
    expect(lines.some((l) => l === '  GOTO L0040')).toBe(true);
  });

  it('round-trips unchanged code onto the original statement numbers', () => {
    const back = fromView(view.text, view);
    expect(back.numbered.map((l) => parseInt(l, 10))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(back.renumbered).toBe(0);
    // each statement is written back on one line
    expect(back.numbered[1]).toMatch(/^0020 IF X=0 THEN LET R\$=R\$\+"a"; GOTO L0040 ELSE GOTO L0050$/);
    expect(back.numbered[3]).toMatch(/^0040 L0040: FOR I=1 TO 3/);
  });

  it('numbers inserted lines into the gaps and keeps the rest', () => {
    const edited = view.text.replace('PRINT "never"', 'PRINT "never"\nPRINT "new 1"\nPRINT "new 2"');
    const back = fromView(edited, view);
    const nums = back.numbered.map((l) => parseInt(l, 10));
    expect(nums.slice(0, 3)).toEqual([10, 20, 30]);
    expect(nums[3]).toBeGreaterThan(30);
    expect(nums[4]).toBeLessThan(40);
    expect(nums.slice(5)).toEqual([40, 50, 60]);
    expect(back.numbered.some((l) => l.endsWith('PRINT "new 2"'))).toBe(true);
  });

  it('renumbers locally when there is no room', () => {
    const tight = ['0001 PRINT 1', '0002 PRINT 2', '0003 PRINT 3', '0050 PRINT 50'];
    const v = toView(tight);
    const back = fromView(v.text.replace('PRINT 1', 'PRINT 1\nPRINT 1.5'), v);
    const nums = back.numbered.map((l) => parseInt(l, 10));
    expect(nums[0]).toBe(1);
    expect(nums[nums.length - 1]).toBe(50);
    expect(nums.every((x, i) => i === 0 || x > nums[i - 1])).toBe(true);
    expect(back.renumbered).toBeGreaterThan(0);
  });

  it('numbers a view without a base sequentially', () => {
    const back = fromView('PRINT 1\n\nPRINT 2\nFOO:\nPRINT 3');
    expect(back.numbered).toEqual(['0010 PRINT 1', '0020 PRINT 2', '0030 FOO: PRINT 3']);
  });

  it('splits after an END_IF only when it closes the outermost IF', () => {
    const v = toView(['0010 IF A THEN X=1 END_IF ; Y=2', '0020 IF A THEN R=1; IF B THEN R=2 ELSE R=3 END_IF ; R=4 ELSE R=5', '0030 END'], { ...defaultViewOptions, expandIf: false });
    const lines = v.text.split('\n').map((l) => l.trim());
    expect(lines).toContain('IF A THEN X = 1');
    expect(lines).toContain('Y = 2');
    expect(lines.some((l) => l.startsWith('IF A THEN R = 1; IF B THEN R = 2 ELSE R = 3 END_IF ; R = 4 ELSE R = 5') || l.startsWith('IF A THEN R = 1; IF B THEN R = 2 ELSE R = 3 END_IF; R = 4 ELSE R = 5'))).toBe(true);
  });

  it('keeps conditional statements together on the IF line', () => {
    const v = toView(['0010 IF A THEN { PRINT 1 } ELSE PRINT 2; PRINT 3', '0020 END'], { ...defaultViewOptions, expandIf: false });
    expect(v.text).toContain('ELSE PRINT 2; PRINT 3');
  });
});

describe('respaceLine', () => {
  it('spaces binary operators and commas but leaves options, unary minus, members and masks alone', () => {
    expect(respaceLine('LET X=A+B*-1')).toBe('LET X = A + B * -1');
    expect(respaceLine('READ (1,KEY=K$,ERR=*NEXT)A$,B')).toBe('READ (1, KEY=K$, ERR=*NEXT) A$, B');
    expect(respaceLine("X=coSession'GetValue(\"a\")'Length")).toBe("X = coSession'GetValue(\"a\")'Length");
    expect(respaceLine('PRINT X:"##0.00",@(1,2)')).toBe('PRINT X:"##0.00", @(1, 2)');
    expect(respaceLine('SELECT *,REC=R$ FROM 1')).toBe('SELECT *, REC=R$ FROM 1');
    expect(respaceLine('X=TBL(N<>0,-1,1)')).toBe('X = TBL(N <> 0, -1, 1)');
    expect(respaceLine('0010 X=1')).toBe('0010 X = 1');
  });
});
