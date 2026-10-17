// ProvideX/TS (.pxts) -> ProvideX (readable, lineless).
//
// Records a position map (segments) between the generated ProvideX and the .pxts source so that the ProvideX
// language features can be reused for .pxts documents.
import { lexTs, TsToken, pvxString, hexLiteral } from './lexer';
import { TAG, upperSnake } from './toPxts';
import { DIRECTIVES } from '../lexicon';

export interface Segment { pl: number; pc0: number; pc1: number; tl: number; tc0: number; tc1: number }
export interface PxtsProblem { line: number; col: number; end: number; message: string; severity?: 'error' | 'warning' }
export interface FromPxtsResult {
  text: string;
  /** .pxts line of each generated ProvideX line */
  srcLine: number[];
  segments: Segment[];
  problems: PxtsProblem[];
  /** modern functions: ts name -> ProvideX name */
  functions: Map<string, string>;
}

interface Piece { text: string; tok?: TsToken }
type Line = Piece[];

interface FnCtx { name: string; prefix: string; loopDepth: number; needsFlag: boolean; str: boolean }

type Out = { pieces: Line; src: number };
interface Deco { name: string; args: TsToken[]; tok: TsToken }

/** ProvideX I/O statements written as calls:  read({ ch: 1, key: k$ }, a$) */
const IO_CALLS: Record<string, string> = {
  read: 'READ', readrecord: 'READ RECORD', write: 'WRITE', writerecord: 'WRITE RECORD', print: 'PRINT', input: 'INPUT', inputrecord: 'INPUT RECORD',
  open: 'OPEN', openlock: 'OPEN LOCK', close: 'CLOSE', extract: 'EXTRACT', extractrecord: 'EXTRACT RECORD', find: 'FIND', findrecord: 'FIND RECORD',
  remove: 'REMOVE', update: 'UPDATE', insert: 'INSERT', lock: 'LOCK', unlock: 'UNLOCK', purge: 'PURGE',
};

const STMT_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'repeat', 'until', 'switch', 'case', 'default', 'select', 'try', 'catch', 'finally', 'class', 'def', 'function', 'let', 'method', 'pvx', 'return', 'goto', 'gosub', 'exitto', 'break', 'continue']);

export function fromPxts(text: string): FromPxtsResult {
  const toks = lexTs(text);
  return new Parser(toks).run();
}

class Parser {
  i = 0;
  lines: { pieces: Line; src: number }[] = [];
  problems: PxtsProblem[] = [];
  functions = new Map<string, string>();
  fn?: FnCtx;
  /** comment written after a closing '}' on the same line, attached to the ProvideX closing statement */
  pendingClose?: TsToken;
  lastClose?: TsToken;

  constructor(private toks: TsToken[]) {
    // pre-pass: modern function names
    for (let k = 0; k + 1 < toks.length; k++) {
      if (toks[k].kind === 'ident' && toks[k].text === 'function' && toks[k + 1].kind === 'ident' && this.atStmtStart(k)) {
        const n = toks[k + 1].text;
        this.functions.set(n.toUpperCase(), 'FN_' + n);
      }
    }
  }

  private atStmtStart(k: number): boolean {
    for (let j = k - 1; j >= 0; j--) {
      const t = this.toks[j];
      if (t.kind === 'eol' || t.kind === 'comment') return true;
      if (t.kind === 'punct' && (t.text === ';' || t.text === '{' || t.text === '}')) return true;
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- token helpers
  peek(o = 0): TsToken { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next(): TsToken { return this.toks[this.i++]; }
  atEnd(): boolean { return this.i >= this.toks.length; }
  is(text: string, o = 0): boolean { const t = this.peek(o); return !!t && t.kind !== 'string' && t.kind !== 'comment' && t.text === text; }
  isKw(kw: string, o = 0): boolean { const t = this.peek(o); return !!t && t.kind === 'ident' && t.text.toLowerCase() === kw; }
  skipEol() { while (!this.atEnd() && this.peek().kind === 'eol') this.i++; }
  problem(t: TsToken, message: string) { this.problems.push({ line: t.line, col: t.col, end: Math.max(t.end, t.col + 1), message }); }
  expect(text: string): TsToken | undefined {
    this.skipEol();
    if (this.is(text)) return this.next();
    this.problem(this.peek(), `Expected "${text}"`);
    return undefined;
  }

  // ---------------------------------------------------------------- output
  out(pieces: Line, src: number) { this.lines.push({ pieces, src }); }
  comment(t: TsToken): Line {
    const v = (t.value ?? '').replace(/^\s/, '');
    // "// REM text" comes from (and goes back to) a REM statement
    if (/^REM(\s|$)/.test(v)) return [{ text: v, tok: t }];
    return [{ text: '! ' + v, tok: t }];
  }

  run(): FromPxtsResult {
    while (!this.atEnd()) {
      // a "}" that closes nothing is kept: ProvideX allows it (legacy programs have them)
      if (this.is('}')) { const c = this.next(); this.lines.push(this.L([{ text: '}', tok: c }], c.line)); continue; }
      const before = this.i;
      this.statement();
      if (this.i === before) this.i++;
    }
    return this.finish();
  }

  private finish(): FromPxtsResult {
    const textLines: string[] = [];
    const srcLine: number[] = [];
    const segments: Segment[] = [];
    this.lines.forEach((l, pl) => {
      let s = '';
      for (const p of l.pieces) {
        if (p.text === '') continue;
        const start = s.length;
        s += p.text;
        if (p.tok) segments.push({ pl, pc0: start, pc1: s.length, tl: p.tok.line, tc0: p.tok.col, tc1: p.tok.end });
      }
      textLines.push(s);
      srcLine.push(l.src);
    });
    return { text: textLines.join('\n'), srcLine, segments, problems: this.problems, functions: this.functions };
  }

  // ---------------------------------------------------------------- statements
  /** Parses one statement and emits its ProvideX line(s). */
  statement(): void {
    const t = this.peek();
    if (t.kind === 'eol') { this.i++; if (this.peek(-2)?.kind === 'eol' || this.i === 1) this.out([], t.line); return; }
    if (t.kind === 'comment') { this.i++; this.out(this.comment(t), t.line); this.eatEol(); return; }
    if (this.is(';')) { this.i++; return; }
    for (const l of this.stmtLines()) this.lines.push(l);
  }

  private eatEol() { if (this.peek().kind === 'eol') this.i++; }

  /** Parses a statement into ProvideX lines (not yet output). Handles trailing comments. */
  stmtLines(): { pieces: Line; src: number }[] {
    const t = this.peek();
    const res = this.stmtCore();
    // trailing ';' and comment
    if (this.is(';')) this.i++;
    if (this.peek().kind === 'comment') {
      const c = this.next();
      if (res.length) res[res.length - 1].pieces.push({ text: ' ' }, ...this.comment(c));
      else res.push({ pieces: this.comment(c), src: c.line });
    }
    if (!res.length && t.kind !== 'eol') return [];
    return res;
  }

  private L(pieces: Line, src: number) { return { pieces, src }; }

  private stmtCore(): { pieces: Line; src: number }[] {
    const t = this.peek();
    const kw = t.kind === 'ident' ? t.text.toLowerCase() : '';
    // label:
    // (a keyword-named label such as FUNCTION: alone on its line is still a label; default: and case x: belong to switch)
    const labelAlone = this.is(':', 1) && (this.peek(2).kind === 'eol' || this.peek(2).kind === 'comment') && kw !== 'default';
    if (t.kind === 'ident' && this.is(':', 1) && (!STMT_KEYWORDS.has(kw) || labelAlone)) { this.i += 2; return [this.L([{ text: t.text, tok: t }, { text: ':' }], t.line)]; }
    if (t.kind === 'raw') { this.i++; return [this.L([{ text: t.value ?? '', tok: t }], t.line)]; }
    if (this.is('{')) {
      // bare block
      this.i++;
      const body = this.blockBody();
      return [this.L([{ text: '{', tok: t }], t.line), ...body, this.closing(this.L([{ text: '}' }], this.peek(-1).line))];
    }
    // a keyword-spelled variable being assigned (CONTINUE = 1, SORT[0] = 2) is not a statement keyword
    const n1 = this.peek(1);
    const assigned = t.kind === 'ident' && ((n1.kind === 'op' && ['=', '+=', '-=', '*=', '/=', '++', '--'].includes(n1.text)) || (n1.kind === 'punct' && n1.text === '[' && n1.col === t.end));
    // decorators: @create(...) class X  /  members (inside classes)
    if (t.kind === 'op' && t.text === '@' && this.peek(1).kind === 'ident') {
      const decos = this.decorators();
      this.skipEol();
      if (this.isKw('class')) return this.classStmt(decos);
      this.problem(t, 'Decorators are only valid on classes and class members');
      return [];
    }
    // I/O statements written as calls
    const io = t.kind === 'ident' ? IO_CALLS[t.text.toLowerCase()] : undefined;
    if (io && this.is('(', 1) && this.peek(1).col === t.end) return this.ioStmt(io);
    if (t.kind === 'ident' && /^(drop|delete)object$/i.test(t.text) && this.is('(', 1)) return this.dropStmt(t.text.toLowerCase().startsWith('drop') ? 'DROP OBJECT' : 'DELETE OBJECT');
    switch (assigned ? '' : kw) {
      case 'const': return this.constStmt();
      case 'pvx': {
        this.i++;
        const r = this.peek();
        if (r.kind === 'raw') { this.i++; return [this.L([{ text: r.value ?? '', tok: r }], t.line)]; }
        this.problem(r, 'Expected pvx`...`');
        return [];
      }
      case 'if': return this.ifStmt();
      case 'for': return this.forStmt();
      case 'while': return this.whileStmt();
      case 'repeat': return this.repeatStmt();
      case 'switch': return this.switchStmt();
      case 'select': return this.selectStmt();
      case 'try': return this.tryStmt();
      case 'catch': case 'finally': return this.braceClause();
      case 'class': return this.classStmt([]);
      case 'def': if (this.peek(1).kind === 'ident' && /^FN/i.test(this.peek(1).text)) return this.defStmt(); break;
      case 'function': return this.functionStmt();
      case 'let': return this.letStmt();
      case 'method': { this.i++; return [this.L([{ text: 'FUNCTION ', tok: t }, ...this.exprUntilEnd()], t.line)]; }
      case 'case': {
        this.i++;
        const stopCase = (x: TsToken) => (x.text === ':' && x.kind === 'punct') || (x.kind === 'punct' && x.text === ';') || x.kind === 'eol' || x.kind === 'comment';
        const e = this.exprUntil(stopCase);
        if (this.is(':')) this.i++;
        // case 1: case 2:  ->  CASE 1,2
        while (this.isKw('case') && this.peek().line === t.line) {
          this.i++;
          e.push({ text: ',' }, ...this.exprUntil(stopCase));
          if (this.is(':')) this.i++;
        }
        return [this.L([{ text: 'CASE ', tok: t }, ...e], t.line)];
      }
      case 'default': if (this.is(':', 1)) { this.i += 2; return [this.L([{ text: 'DEFAULT', tok: t }], t.line)]; } break;
      case 'return': {
        this.i++;
        const e = this.exprUntilEnd();
        const f = this.fn;
        if (f && f.loopDepth > 0) {
          f.needsFlag = true;
          const ret = f.prefix + '.ret' + (f.str ? '$' : '');
          return [this.L([{ text: `${ret}=`, tok: t }, ...(e.length ? e : [{ text: f.str ? '""' : '0' }]), { text: `; ${f.prefix}.done=1; BREAK ! ${TAG} return` }], t.line)];
        }
        return [this.L([{ text: 'RETURN', tok: t }, ...(e.length ? [{ text: ' ' }, ...e] : f ? [{ text: f.str ? ' ""' : ' 0' }] : [])], t.line)];
      }
      case 'break': case 'continue': this.i++; return [this.L([{ text: kw.toUpperCase(), tok: t }], t.line)];
      case 'goto': case 'gosub': case 'exitto': { this.i++; return [this.L([{ text: kw.toUpperCase() + ' ', tok: t }, ...this.exprUntilEnd()], t.line)]; }
    }
    // other ProvideX directives (print, read, open, ...) and expression statements
    const pieces = this.exprUntilEnd(true);
    // an assignment to a variable spelled like a directive (SORT[0] = 1, INDEX = 2) needs an explicit LET
    if (t.kind === 'ident' && DIRECTIVES.has(t.text.toUpperCase()) && this.isAssignment(pieces)) pieces.unshift({ text: 'LET ' });
    return [this.L(pieces, t.line)];
  }

  /** { statements }  (the '{' was already consumed) */
  private blockBody(): { pieces: Line; src: number }[] {
    const out: { pieces: Line; src: number }[] = [];
    for (;;) {
      if (this.atEnd()) { this.problem(this.peek(-1), 'Missing "}"'); return out; }
      const t = this.peek();
      if (t.kind === 'eol') { this.i++; if (this.peek(-2)?.kind === 'eol') out.push(this.L([], t.line)); continue; }
      if (this.is('}')) {
        const close = this.next();
        this.lastClose = close;
        if (this.peek().kind === 'comment' && this.peek().line === close.line) this.pendingClose = this.next();
        return out;
      }
      if (t.kind === 'comment') { this.i++; out.push(this.L(this.comment(t), t.line)); continue; }
      if (this.is(';')) { this.i++; continue; }
      const before = this.i;
      out.push(...this.stmtLines());
      if (this.i === before) { this.problem(t, 'Unexpected token'); this.i++; }
    }
  }

  /** Statement body: a block or a single statement. */
  private body(): { lines: { pieces: Line; src: number }[]; block: boolean; trailing?: TsToken; oneLine?: boolean } {
    this.skipEol();
    if (this.is('{')) {
      const open = this.next();
      let trailing: TsToken | undefined;
      if (this.peek().kind === 'comment') trailing = this.next();
      const lines = this.blockBody();
      return { lines, block: true, trailing, oneLine: !trailing && this.lastClose?.line === open.line };
    }
    return { lines: this.stmtLines(), block: false };
  }

  /** Attaches a pending "} // comment" to a closing ProvideX line. */
  private closing(l: { pieces: Line; src: number }) {
    if (this.pendingClose) { l.pieces.push({ text: ' ' }, ...this.comment(this.pendingClose)); this.pendingClose = undefined; }
    return l;
  }

  /** Consumes '{' and a comment on the same line; returns the comment pieces for the header line. */
  private openBrace(): Line {
    this.skipEol();
    if (!this.is('{')) { this.problem(this.peek(), 'Expected "{"'); return []; }
    const b = this.next();
    if (this.peek().kind === 'comment' && this.peek().line === b.line) return [{ text: ' ' }, ...this.comment(this.next())];
    return [];
  }

  private parenExpr(): Line {
    this.skipEol();
    if (!this.is('(')) { this.problem(this.peek(), 'Expected "("'); return this.exprUntilEnd(); }
    this.i++;
    const e = this.exprUntil((x) => x.text === ')' && x.kind === 'punct', true);
    if (this.is(')')) this.i++;
    return e;
  }

  private ifStmt(): { pieces: Line; src: number }[] {
    const t = this.next();
    const cond = this.parenExpr();
    const thenB = this.body();
    const thenClose = thenB.block ? this.lastClose : undefined;
    const thenCloseComment = thenB.block ? this.pendingClose : undefined;
    if (thenB.block) this.pendingClose = undefined;
    // else on the same or a following line
    let save = this.i;
    this.skipEol();
    let elseB: ReturnType<Parser['body']> | undefined;
    let elseIf: { pieces: Line; src: number }[] | undefined;
    let elseTok: TsToken | undefined;
    if (this.isKw('else')) {
      elseTok = this.next();
      if (this.isKw('if')) elseIf = this.ifStmt();
      else elseB = this.body();
    } else this.i = save;
    // a one-line body can stay on the IF line unless it carries a comment (which would swallow ELSE)
    const simple = (b: ReturnType<Parser['body']>) => !b.block && b.lines.length === 1 && !b.lines[0].pieces.some((p) => /^\s*! /.test(p.text) || p.text.includes(' ! '));
    const head: Line = [{ text: 'IF ', tok: t }, ...cond, { text: ' THEN' }];
    // "{ a; b }" written on one line stays a one-line THEN a; b (as ProvideX wrote it)
    const inline = (b: ReturnType<Parser['body']>) => !!b.block && !!b.oneLine && b.lines.length > 0 && b.lines.every((l) => l.pieces.length && !l.pieces.some((p) => p.text === ' {' || p.text === '{' || p.text === '}' || /^\s*! /.test(p.text) || p.text.includes(' ! ')));
    for (const b of [thenB, elseB]) if (b && inline(b)) {
      const joined: Line = [];
      b.lines.forEach((l, k) => { if (k) joined.push({ text: '; ' }); joined.push(...l.pieces); });
      b.lines = [{ pieces: joined, src: b.lines[0].src }];
      b.block = false;
    }
    // single-line form
    const oneLine = (b: ReturnType<Parser['body']>) => !b.block && b.lines.length === 1;
    if (elseTok ? simple(thenB) && ((!!elseB && oneLine(elseB)) || (!!elseIf && elseIf.length === 1)) : oneLine(thenB)) {
      const line: Line = [...head, { text: ' ' }, ...thenB.lines[0].pieces];
      if (elseB) line.push({ text: ' ' }, { text: 'ELSE ', tok: elseTok }, ...elseB.lines[0].pieces);
      if (elseIf) line.push({ text: ' ' }, { text: 'ELSE ', tok: elseTok }, ...elseIf[0].pieces);
      return [this.L(line, t.line)];
    }
    // block form
    const out: { pieces: Line; src: number }[] = [this.L([...head, { text: ' {' }, ...(thenB.trailing ? [{ text: ' ' }, ...this.comment(thenB.trailing)] : [])], t.line), ...thenB.lines];
    if (elseIf) {
      // "} ELSE IF c THEN {" chain: reuse the nested IF's first line
      const first = elseIf[0];
      if (first.pieces[first.pieces.length - 1]?.text === ' {' || first.pieces.some((p) => p.text === ' {')) {
        out.push(this.L([{ text: '} ', tok: elseTok }, { text: 'ELSE ' }, ...first.pieces], first.src), ...elseIf.slice(1));
        return out;
      }
      out.push(this.L([{ text: '} ', tok: elseTok }, { text: 'ELSE {' }], elseTok!.line), ...elseIf, this.closing(this.L([{ text: '}' }], elseTok!.line)));
      return out;
    }
    if (elseB && !elseB.block && elseB.lines.length === 1 && thenClose && elseTok && elseTok.line > thenClose.line) {
      // "}" and "else stmt" on separate lines (as some ProvideX code is written)
      const close = this.L([{ text: '}', tok: thenClose }], thenClose.line);
      if (thenCloseComment) close.pieces.push({ text: ' ' }, ...this.comment(thenCloseComment));
      const ep = elseB.lines[0].pieces;
      out.push(close, this.L([{ text: 'ELSE ', tok: elseTok }, ...(this.isAssignment(ep) ? [{ text: 'LET ' }] : []), ...ep], elseTok.line));
      return out;
    }
    if (thenCloseComment) this.pendingClose = this.pendingClose ?? thenCloseComment;
    if (elseB && !elseB.block && elseB.lines.length === 1) {
      // "} else stmt"  ->  "} ELSE stmt" (no block)
      out.push(this.L([{ text: '} ', tok: elseTok }, { text: 'ELSE ' }, ...elseB.lines[0].pieces], elseTok!.line));
      return out;
    }
    if (elseB) {
      out.push(this.L([{ text: '} ', tok: elseTok }, { text: 'ELSE {' }, ...(elseB.trailing ? [{ text: ' ' }, ...this.comment(elseB.trailing)] : [])], elseTok!.line), ...elseB.lines);
    }
    out.push(this.closing(this.L([{ text: '}' }], this.peek(-1).line)));
    return out;
  }

  private loopBody(head: { pieces: Line; src: number }, close: (line: number) => { pieces: Line; src: number }[]): { pieces: Line; src: number }[] {
    const f = this.fn;
    if (f) f.loopDepth++;
    const before = f?.needsFlag ?? false;
    if (f) f.needsFlag = false;
    const b = this.body();
    if (b.trailing) head.pieces.push({ text: ' ' }, ...this.comment(b.trailing));
    const inner = f?.needsFlag ?? false;
    if (f) { f.loopDepth--; f.needsFlag = before || inner; }
    const closeLines = close(this.peek(-1).line);
    if (closeLines.length) this.closing(closeLines[closeLines.length - 1]);
    const out = [head, ...b.lines, ...closeLines];
    if (f && inner) {
      const ret = f.prefix + '.ret' + (f.str ? '$' : '');
      out.push(this.L([{ text: f.loopDepth > 0 ? `IF ${f.prefix}.done THEN BREAK ! ${TAG} loopret` : `IF ${f.prefix}.done THEN RETURN ${ret} ! ${TAG} loopret` }], this.peek(-1).line));
    }
    return out;
  }

  private forStmt() {
    const t = this.next();
    this.skipEol();
    // C-style header?
    let d = 0, cstyle = false;
    for (let k = this.i; k < this.toks.length; k++) {
      const x = this.toks[k];
      if (x.kind === 'punct' && (x.text === '(' || x.text === '[')) d++;
      else if (x.kind === 'punct' && (x.text === ')' || x.text === ']')) { d--; if (d === 0) break; }
      else if (d === 1 && x.kind === 'punct' && x.text === ';') { cstyle = true; break; }
    }
    if (cstyle) return this.forCStyle(t);
    this.expect('(');
    const v = this.exprUntil((x) => x.kind === 'op' && x.text === '=');
    if (this.is('=')) this.i++;
    const from = this.exprUntil((x) => x.kind === 'ident' && x.text.toLowerCase() === 'to');
    const toTok = this.isKw('to') ? this.next() : undefined;
    if (!toTok) this.problem(this.peek(), 'Expected "to"');
    const to = this.exprUntil((x) => (x.kind === 'ident' && x.text.toLowerCase() === 'step') || (x.kind === 'punct' && x.text === ')'), true);
    let step: Line = [];
    if (this.isKw('step')) { const s = this.next(); step = [{ text: ' STEP ', tok: s }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true)]; }
    this.expect(')');
    const head = this.L([{ text: 'FOR ', tok: t }, ...v, { text: '=' }, ...from, { text: ' TO', tok: toTok }, { text: ' ' }, ...to, ...step], t.line);
    const varText = v.map((p) => p.text).join('').trim();
    return this.loopBody(head, (ln) => [this.L([{ text: 'NEXT ' + varText }], ln)]);
  }

  /** for (i = a; i <= b; i++ | i += s | i-- | i -= s)  ->  FOR i=a TO b [STEP s] */
  private forCStyle(t: TsToken) {
    this.expect('(');
    if (this.isKw('let')) this.i++;
    const v = this.exprUntil((x) => x.kind === 'op' && x.text === '=');
    if (this.is('=')) this.i++;
    const from = this.exprUntil((x) => x.kind === 'punct' && x.text === ';');
    this.expect(';');
    const cv = this.next();
    const op = this.next();
    if (cv.kind !== 'ident' || !(op.kind === 'op' && (op.text === '<=' || op.text === '>='))) this.problem(op, 'ProvideX FOR loops run to an inclusive bound: write  i <= end  or  i >= end');
    const to = this.exprUntil((x) => x.kind === 'punct' && x.text === ';');
    this.expect(';');
    const uv = this.next();
    const uop = this.next();
    let step: Line = [];
    if (uop.kind === 'op' && uop.text === '++') step = [];
    else if (uop.kind === 'op' && uop.text === '--') step = [{ text: ' STEP -1', tok: uop }];
    else if (uop.kind === 'op' && uop.text === '+=') step = [{ text: ' STEP ', tok: uop }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true)];
    else if (uop.kind === 'op' && uop.text === '-=') step = [{ text: ' STEP -', tok: uop }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true)];
    else this.problem(uop, 'Expected i++, i--, i += step or i -= step');
    void uv;
    this.expect(')');
    const head = this.L([{ text: 'FOR ', tok: t }, ...v, { text: '=' }, ...from, { text: ' TO ' }, ...to, ...step], t.line);
    const varText = v.map((p) => p.text).join('').trim();
    return this.loopBody(head, (ln) => [this.L([{ text: 'NEXT ' + varText }], ln)]);
  }

  private whileStmt() {
    const t = this.next();
    const cond = this.parenExpr();
    return this.loopBody(this.L([{ text: 'WHILE ', tok: t }, ...cond], t.line), (ln) => [this.L([{ text: 'WEND' }], ln)]);
  }

  private repeatStmt() {
    const t = this.next();
    let untilLine: { pieces: Line; src: number } | undefined;
    return this.loopBody(this.L([{ text: 'REPEAT', tok: t }], t.line), () => {
      this.skipEol();
      const u = this.isKw('until') ? this.next() : undefined;
      if (!u) { this.problem(this.peek(), 'Expected "until (...)" after repeat { }'); return [this.L([{ text: 'UNTIL 1' }], this.peek().line)]; }
      const cond = this.parenExpr();
      if (this.is(';')) this.i++;
      untilLine = this.L([{ text: 'UNTIL ', tok: u }, ...cond], u.line);
      if (this.peek().kind === 'comment' && this.peek().line === u.line) untilLine.pieces.push({ text: ' ' }, ...this.comment(this.next()));
      return [untilLine];
    });
  }

  private switchStmt() {
    const t = this.next();
    const e = this.parenExpr();
    // BREAK inside SWITCH leaves only the SWITCH, so a lowered return is re-checked after END SWITCH (loopBody)
    return this.loopBody(this.L([{ text: 'SWITCH ', tok: t }, ...e], t.line), (ln) => [this.L([{ text: 'END SWITCH' }], ln)]);
  }

  private selectStmt() {
    const t = this.next();
    const hdr = this.exprUntil((x) => x.kind === 'punct' && x.text === '{', false, true);
    return this.loopBody(this.L([{ text: 'SELECT ', tok: t }, ...hdr], t.line), (ln) => [this.L([{ text: 'NEXT RECORD' }], ln)]);
  }

  private tryStmt() {
    const t = this.next();
    const head = this.L([{ text: 'TRY', tok: t }], t.line);
    const out = [head];
    const b = this.body();
    if (b.trailing) head.pieces.push({ text: ' ' }, ...this.comment(b.trailing));
    const closeLine = this.peek(-1).line;
    // brace form: "catch {" starts on a new line  ->  TRY { } / CATCH { } / FINALLY { }
    if (!(this.isKw('catch') || this.isKw('finally'))) {
      head.pieces.push({ text: ' {' });
      return [...out, ...b.lines, this.closing(this.L([{ text: '}' }], closeLine))];
    }
    out.push(...b.lines);
    for (;;) {
      const save = this.i;
      if (this.isKw('catch') || this.isKw('finally')) {
        const k = this.next();
        let args: Line = [];
        if (this.is('(')) { this.i++; args = [{ text: ' ' }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true)]; if (this.is(')')) this.i++; }
        const kl = this.L([{ text: k.text.toUpperCase(), tok: k }, ...args], k.line);
        out.push(kl);
        const kb = this.body();
        if (kb.trailing) kl.pieces.push({ text: ' ' }, ...this.comment(kb.trailing));
        out.push(...kb.lines);
        continue;
      }
      this.i = save;
      break;
    }
    out.push(this.closing(this.L([{ text: 'END_TRY' }], this.peek(-1).line)));
    return out;
  }

  /** Brace-form handler at statement start:  catch { ... }  /  finally { ... } */
  private braceClause() {
    const k = this.next();
    let args: Line = [];
    if (this.is('(')) { this.i++; args = [{ text: ' ' }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true)]; if (this.is(')')) this.i++; }
    const head = this.L([{ text: k.text.toUpperCase(), tok: k }, ...args, { text: ' {' }], k.line);
    head.pieces.push(...this.openBrace());
    const body = this.blockBody();
    return [head, ...body, this.closing(this.L([{ text: '}' }], this.peek(-1).line))];
  }

  /** @name(args) ... (possibly several, possibly on several lines) */
  /** comments written between decorators and what they decorate */
  private decoComments: TsToken[] = [];

  private decorators(): Deco[] {
    const out: Deco[] = [];
    for (;;) {
      while (this.peek().kind === 'eol' || this.peek().kind === 'comment') { const c = this.next(); if (c.kind === 'comment') this.decoComments.push(c); }
      if (!(this.is('@') && this.peek(1).kind === 'ident')) break;
      const at = this.next();
      const name = this.next();
      const args: TsToken[] = [];
      if (this.is('(') && this.peek().col === name.end) {
        this.i++;
        let d = 1;
        while (!this.atEnd()) {
          const x = this.next();
          if (x.kind === 'punct' && x.text === '(') d++;
          else if (x.kind === 'punct' && x.text === ')') { d--; if (d === 0) break; }
          if (x.kind !== 'eol') args.push(x);
        }
      }
      out.push({ name: name.text.toLowerCase(), args, tok: at });
    }
    return out;
  }

  private decoArg(d: Deco | undefined): string | undefined {
    const a = d?.args.find((x) => x.kind === 'ident');
    return a ? (a.text.toLowerCase() === 'err' ? 'ERR' : a.text) : undefined;
  }

  /**
   * class X extends A, B { fields; methods }  ->  DEF CLASS "X" ... LIKE "A","B" / PROPERTY / LOCAL / FUNCTION ... END DEF
   * followed by the method bodies as  LABEL: ENTER args ... sections (in the order the methods are written).
   */
  private classStmt(classDecos: Deco[]): Out[] {
    const t = this.next();
    const nameTok = this.next();
    const name: Line = nameTok.kind === 'string' ? [{ text: pvxString(nameTok.value ?? ''), tok: nameTok }] : [{ text: '"' + nameTok.text + '"', tok: nameTok }];
    const parents: TsToken[] = [];
    if (this.isKw('extends')) {
      this.i++;
      while (!this.atEnd() && !this.is('{')) { const x = this.next(); if (x.kind === 'ident' || x.kind === 'string') parents.push(x); else if (x.kind === 'eol') continue; }
    }
    const rest = this.exprUntil((x) => x.kind === 'punct' && x.text === '{', false, true);
    // @create(label, required) / @delete(...) / @pvx("...")
    const clauses: Line = [];
    let createLabel: string | undefined, deleteLabel: string | undefined;
    for (const d of classDecos) {
      if (d.name === 'create' || d.name === 'delete') {
        const words = d.args.filter((x) => x.kind === 'ident').map((x) => x.text);
        const label = words.find((w) => w.toLowerCase() !== 'required');
        if (d.name === 'create') createLabel = label; else deleteLabel = label;
        clauses.push({ text: ' ' + d.name.toUpperCase(), tok: d.tok }, ...(label ? [{ text: ' ' + label }] : []), ...(words.some((w) => w.toLowerCase() === 'required') ? [{ text: ' REQUIRED' }] : []));
      } else if (d.name === 'pvx') {
        const str = d.args.find((x) => x.kind === 'string');
        clauses.push({ text: ' ' + (str?.value ?? ''), tok: d.tok });
        // DEF CLASS "X" UNIQUE CREATE OnCreate: the constructor's label
        const lbl = (w: string) => { const m = new RegExp('\\b' + w + '\\s+(?!REQUIRED\\b)([A-Za-z_][A-Za-z0-9_]*)', 'i').exec(str?.value ?? ''); return m ? m[1] : undefined; };
        createLabel ??= lbl('CREATE');
        deleteLabel ??= lbl('DELETE');
      } else this.problem(d.tok, `Unknown class decorator @${d.name}`);
    }
    const lead = this.decoComments.splice(0).map((c) => this.L(this.comment(c), c.line));
    const head = this.L([{ text: 'DEF CLASS ', tok: t }, ...name, ...clauses, ...(rest.length ? [{ text: ' ' }, ...rest] : [])], t.line);
    head.pieces.push(...this.openBrace());
    const header: Out[] = [];
    for (const p of parents) header.push(this.L([{ text: 'LIKE ' }, { text: p.kind === 'string' ? pvxString(p.value ?? '') : '"' + p.text + '"', tok: p }], p.line));
    const impl: Out[] = [];
    const accessorLabel = new Map<string, string>(); // "GET:NAME" -> label
    let sigs: { flags: { local: boolean; perform: boolean }; name: TsToken; params: TsToken[]; comment?: TsToken }[] = [];
    for (;;) {
      if (this.atEnd()) { this.problem(t, 'Missing "}" for class'); break; }
      const x = this.peek();
      if (x.kind === 'eol') { this.i++; if (this.peek(-2)?.kind === 'eol') header.push(this.L([], x.line)); continue; }
      if (this.is('}')) { const c = this.next(); this.lastClose = c; if (this.peek().kind === 'comment' && this.peek().line === c.line) this.pendingClose = this.next(); break; }
      if (x.kind === 'comment') { this.i++; header.push(this.L(this.comment(x), x.line)); continue; }
      if (this.is(';')) { this.i++; continue; }
      const decos = this.is('@') ? this.decorators() : [];
      for (const c of this.decoComments.splice(0)) header.push(this.L(this.comment(c), c.line));
      this.skipEol();
      const m = this.peek();
      const low = m.kind === 'ident' ? m.text.toLowerCase() : '';
      const flags = { local: false, perform: decos.some((d) => d.name === 'perform') };
      // fields
      if (low === 'public' || low === 'readonly') {
        this.i++;
        const names: TsToken[] = [];
        while (!this.atEnd() && !this.is(';') && this.peek().kind !== 'eol' && this.peek().kind !== 'comment') { const n = this.next(); if (n.kind === 'ident') names.push(n); }
        if (this.is(';')) this.i++;
        const get = this.decoArg(decos.find((d) => d.name === 'get'));
        const set = low === 'readonly' ? 'ERR' : this.decoArg(decos.find((d) => d.name === 'set'));
        for (const n of names) { if (get) accessorLabel.set('GET:' + n.text.toUpperCase(), get); if (set && set !== 'ERR') accessorLabel.set('SET:' + n.text.toUpperCase(), set); }
        const line = this.L([{ text: 'PROPERTY ', tok: m }, ...names.flatMap((n, k) => [...(k ? [{ text: ',' }] : []), { text: n.text.replace(/::/g, '.'), tok: n }]), ...(get ? [{ text: ' GET ' + get }] : []), ...(set ? [{ text: ' SET ' + set }] : [])], m.line);
        if (this.peek().kind === 'comment') line.pieces.push({ text: ' ' }, ...this.comment(this.next()));
        header.push(line);
        continue;
      }
      if (low === 'private') {
        this.i++;
        const n1 = this.peek(), n2 = this.peek(1);
        if (n1.kind === 'ident' && n2.kind === 'punct' && n2.text === '(' && n2.col === n1.end) { flags.local = true; }
        else {
          const line = this.L([{ text: 'LOCAL ', tok: m }, ...this.exprUntilEnd()], m.line);
          if (this.is(';')) this.i++;
          if (this.peek().kind === 'comment') line.pieces.push({ text: ' ' }, ...this.comment(this.next()));
          header.push(line);
          continue;
        }
      }
      const mt = this.peek();
      const mlow = mt.kind === 'ident' ? mt.text.toLowerCase() : '';
      const accessor = (mlow === 'get' || mlow === 'set') && this.peek(1).kind === 'ident' && this.is('(', 2);
      let isMethod = mt.kind === 'ident' && (accessor || (this.is('(', 1) && this.peek(1).col === mt.end));
      // print(...), writeRecord({ ch: c }, x$), dropObject(o) ... in a class body are statements, unless they are
      // plain signatures of a method of that name:  Print(a$);  Print(a$) { ... }
      if (isMethod && !accessor && (IO_CALLS[mlow] || /^(drop|delete)object$/.test(mlow))) isMethod = this.looksLikeSignature(mt.text);
      if (!isMethod) {
        // anything else in a class body: ProvideX header statements (old syntax: like/property/local/method ...)
        const before = this.i;
        header.push(...this.stmtLines());
        if (this.i === before) { this.problem(mt, 'Unexpected token in class'); this.i++; }
        continue;
      }
      let accKind = '';
      if (accessor) { accKind = mlow; this.i++; }
      const nameT = this.next();
      // parameters
      this.i++; // (
      const params: TsToken[] = [];
      const optional: boolean[] = [];
      // each parameter is the text up to the next comma (dotted names: in::Key$ / in.Key$)
      let cur: TsToken | undefined;
      while (!this.atEnd() && !this.is(')')) {
        const p = this.next();
        if (p.kind === 'eol') continue;
        if (p.kind === 'punct' && p.text === ',') { cur = undefined; continue; }
        if (p.kind === 'op' && p.text === '?') { optional[optional.length - 1] = true; continue; }
        if (!cur) { cur = { ...p }; params.push(cur); optional.push(false); }
        else { cur.text += p.text; cur.end = p.end; }
      }
      if (this.is(')')) this.i++;
      const paramText = (ps: TsToken[]) => ps.map((p) => p.text.replace(/::/g, '.')).join(',');
      const pvxName = (n: TsToken) => n.text.replace(/::/g, '.');
      const nm = nameT.text.toLowerCase();
      // overload signature   Name(a$);
      if (this.is(';') || this.peek().kind === 'eol' || this.peek().kind === 'comment') {
        if (this.is(';')) this.i++;
        sigs.push({ flags: { ...flags }, name: nameT, params, comment: this.peek().kind === 'comment' ? this.next() : undefined });
        continue;
      }
      // declaration bound to a label   Name(a$) => LABEL;
      if (this.is('=>')) {
        this.i++;
        const lbl = this.next();
        if (this.is(';')) this.i++;
        const line = this.L([{ text: 'FUNCTION ' + (flags.local ? 'LOCAL ' : '') + (flags.perform ? 'PERFORM ' : ''), tok: mt }, { text: pvxName(nameT), tok: nameT }, { text: '(' + paramText(params) + ')' }, { text: lbl.text.toLowerCase() === 'err' ? ' ERR' : lbl.text, tok: lbl }], mt.line);
        if (this.peek().kind === 'comment') line.pieces.push({ text: ' ' }, ...this.comment(this.next()));
        header.push(line);
        continue;
      }
      if (!this.is('{')) { this.problem(this.peek(), 'Expected "{", "=>" or ";" after a method signature'); continue; }
      const open = this.next();
      // inline function:  Item(X) { return expr; }   (written on one line)
      if (this.isKw('return') && !accKind && nm !== 'constructor' && nm !== 'destructor') {
        const save = this.i;
        this.i++;
        const e = this.exprUntil((x) => (x.kind === 'punct' && (x.text === ';' || x.text === '}')) || x.kind === 'eol');
        if (this.is(';')) this.i++;
        if (this.is('}') && this.peek().line === open.line) {
          this.i++;
          header.push(this.L([{ text: 'FUNCTION ' + (flags.local ? 'LOCAL ' : '') + (flags.perform ? 'PERFORM ' : ''), tok: mt }, { text: pvxName(nameT), tok: nameT }, { text: '(' + paramText(params) + ')=' }, ...e], mt.line));
          sigs = [];
          continue;
        }
        this.i = save;
      }
      let methodComment: Line = [];
      if (this.peek().kind === 'comment' && this.peek().line === open.line) methodComment = [{ text: ' ' }, ...this.comment(this.next())];
      const body = this.blockBody();
      const explicit = this.decoArg(decos.find((d) => d.name === 'label'));
      let label: string;
      if (nm === 'constructor' && !accKind) label = explicit ?? createLabel ?? 'ON_CREATE';
      else if (nm === 'destructor' && !accKind) label = explicit ?? deleteLabel ?? 'ON_DELETE';
      else if (accKind) label = explicit ?? accessorLabel.get(accKind.toUpperCase() + ':' + nameT.text.toUpperCase()) ?? accKind.toUpperCase() + '_' + upperSnake(nameT.text);
      else {
        label = explicit ?? upperSnake(nameT.text);
        const decls: typeof sigs = sigs.length ? sigs : [{ flags, name: nameT, params }];
        for (const sg of decls) header.push(this.L([{ text: 'FUNCTION ' + (sg.flags.local ? 'LOCAL ' : '') + (sg.flags.perform ? 'PERFORM ' : ''), tok: sg.name }, { text: pvxName(sg.name), tok: sg.name }, { text: '(' + paramText(sg.params) + ')' + label }, ...(sg.comment ? [{ text: ' ' }, ...this.comment(sg.comment)] : [])], sg.name.line));
      }
      sigs = [];
      impl.push(this.L([{ text: label, tok: nameT }, { text: ':' }, ...methodComment], nameT.line));
      if (params.length) impl.push(this.L([{ text: 'ENTER ' + paramText(params) + (optional.some(Boolean) ? ',ERR=*NEXT' : '') }], nameT.line));
      impl.push(...body);
      const closeLine = this.closing(this.L([], this.peek(-1).line));
      if (closeLine.pieces.length) impl.push(closeLine);
    }
    return [...lead, head, ...header, this.closing(this.L([{ text: 'END DEF' }], this.peek(-1).line)), ...impl];
  }

  /** At NAME(...): plain parameters followed by a body, "=>", or more signatures of the same method. */
  private looksLikeSignature(name: string): boolean {
    let k = this.i + 2, d = 1;
    for (; k < this.toks.length; k++) {
      const x = this.toks[k];
      if (x.kind === 'punct' && x.text === '(') return false;
      if (x.kind === 'punct' && x.text === ')') { d--; break; }
      if (!(x.kind === 'ident' || x.kind === 'eol' || (x.kind === 'punct' && x.text === ',') || (x.kind === 'op' && (x.text === '?' || x.text === '*')))) return false;
    }
    if (d !== 0) return false;
    let n = this.toks[k + 1];
    if (n && ((n.kind === 'punct' && n.text === '{') || (n.kind === 'op' && n.text === '=>'))) return true;
    // a signature: the next member must be the same method
    for (k += 1; k < this.toks.length; k++) {
      n = this.toks[k];
      if (n.kind === 'eol' || n.kind === 'comment' || (n.kind === 'punct' && n.text === ';')) continue;
      if (n.kind === 'ident' && /^(private|public)$/i.test(n.text)) continue;
      if (n.kind === 'op' && n.text === '@') { k++; if (this.toks[k + 1]?.text === '(') { let dd = 0; for (k++; k < this.toks.length; k++) { if (this.toks[k].text === '(') dd++; else if (this.toks[k].text === ')' && --dd === 0) break; } } continue; }
      return n.kind === 'ident' && n.text.toLowerCase() === name.toLowerCase();
    }
    return false;
  }

  /** const FNX = (A, B$) => expr;  ->  DEF FNX(A,B$)=expr */
  private constStmt(): Out[] {
    const t = this.next();
    const name = { ...this.next() };
    while (this.peek().kind === 'ident' && this.peek().col === name.end) { const x = this.next(); name.text += x.text; name.end = x.end; } // FN%NAME
    if (!/^FN/i.test(name.text)) this.problem(name, 'const declares a ProvideX DEF FN function: its name must start with FN');
    this.expect('=');
    const sig = this.exprUntil((x) => x.kind === 'op' && x.text === '=>');
    if (this.is('=>')) this.i++;
    const e = this.exprUntilEnd();
    const params = sig.map((p) => p.text).join('').trim();
    return [this.L([{ text: 'DEF ', tok: t }, { text: name.text, tok: name }, ...(params === '()' ? [] : sig), { text: '=' }, ...e], t.line)];
  }

  /** read({ ch: 1, key: k$, err: *NEXT }, a$, b)  ->  READ (1,KEY=k$,ERR=*NEXT)a$,b */
  private ioStmt(directive: string): Out[] {
    const t = this.next();
    this.i++; // (
    const pieces: Line = [{ text: directive, tok: t }];
    if (this.is('{')) {
      this.i++;
      const entries = this.objectEntries();
      const ch = entries.find((e) => e.key.toLowerCase() === 'ch');
      const opts = entries.filter((e) => e !== ch);
      pieces.push({ text: ' (' }, ...(ch?.value ?? []), ...opts.flatMap((o) => [{ text: ',' + o.key.toUpperCase() + '=', tok: o.tok }, ...o.value]), { text: ')' });
      if (this.is(',')) this.i++;
    } else pieces.push({ text: ' ' });
    const args = this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true);
    if (this.is(')')) this.i++;
    return [this.L([...pieces, ...args], t.line)];
  }

  /** dropObject(a, b, { err: *NEXT })  ->  DROP OBJECT a,b,ERR=*NEXT */
  private dropStmt(directive: string): Out[] {
    const t = this.next();
    this.i++; // (
    const args = this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true);
    if (this.is(')')) this.i++;
    return [this.L([{ text: directive + ' ', tok: t }, ...args], t.line)];
  }

  /** { key: value, ... } with the '{' consumed; consumes the closing '}' */
  private objectEntries(): { key: string; tok: TsToken; value: Line }[] {
    const out: { key: string; tok: TsToken; value: Line }[] = [];
    for (;;) {
      this.skipEol();
      if (this.atEnd() || this.is('}')) { if (this.is('}')) this.i++; break; }
      const k = this.next();
      if (!this.is(':')) { this.problem(k, 'Expected "name: value"'); break; }
      this.i++;
      const value = this.exprUntil((x) => x.kind === 'punct' && (x.text === ',' || x.text === '}'), true);
      out.push({ key: k.text, tok: k, value });
      if (this.is(',')) this.i++;
    }
    return out;
  }

  private defStmt() {
    // def FNX(A) => expr;   |  def FNX(A) { ... }
    const t = this.next();
    const sig = this.exprUntil((x) => (x.kind === 'op' && x.text === '=>') || (x.kind === 'punct' && x.text === '{'), false, true);
    if (this.is('=>')) {
      this.i++;
      const e = this.exprUntilEnd();
      return [this.L([{ text: 'DEF ', tok: t }, ...sig, { text: '=' }, ...e], t.line)];
    }
    const head = this.L([{ text: 'DEF ', tok: t }, ...sig], t.line);
    head.pieces.push(...this.openBrace());
    const body = this.blockBody();
    return [head, ...body, this.closing(this.L([{ text: 'END DEF' }], this.peek(-1).line))];
  }

  private functionStmt() {
    // function name$(a$, b) { ... }  ->  DEF FN_name$(fn_name.a$,fn_name.b) with LOCAL copies
    const t = this.next();
    const nameTok = this.next();
    const name = nameTok.text;
    const prefix = 'px_' + name.replace(/[$%]$/, '');
    const params: TsToken[] = [];
    this.expect('(');
    while (!this.atEnd() && !this.is(')')) {
      const p = this.next();
      if (p.kind === 'ident') params.push(p);
      else if (!(p.kind === 'punct' && p.text === ',') && p.kind !== 'eol') this.problem(p, 'Expected a parameter name');
    }
    this.expect(')');
    // collect let-declared names in the body (function scope, like LOCAL)
    const locals: string[] = params.map((p) => p.text);
    let depth = 0;
    for (let k = this.i; k < this.toks.length; k++) {
      const x = this.toks[k];
      if (x.kind === 'punct' && x.text === '{') depth++;
      else if (x.kind === 'punct' && x.text === '}') { depth--; if (depth <= 0) break; }
      else if (x.kind === 'ident' && x.text === 'let') {
        for (let j = k + 1; j < this.toks.length; j++) {
          const y = this.toks[j];
          if (y.kind === 'ident' && (this.toks[j - 1] === x || (this.toks[j - 1].kind === 'punct' && this.toks[j - 1].text === ','))) { if (!locals.some((l) => l.toUpperCase() === y.text.toUpperCase())) locals.push(y.text); }
          if (y.kind === 'eol' || (y.kind === 'punct' && y.text === ';')) break;
          if (y.kind === 'punct' && (y.text === '(' || y.text === '[')) { // skip initializer groups
            let d = 0; for (; j < this.toks.length; j++) { const z = this.toks[j]; if (z.kind === 'punct' && (z.text === '(' || z.text === '[')) d++; else if (z.kind === 'punct' && (z.text === ')' || z.text === ']')) { d--; if (d === 0) break; } }
          }
        }
      }
    }
    const outer = this.fn;
    const ctx: FnCtx = { name, prefix, loopDepth: 0, needsFlag: false, str: name.endsWith('$') };
    this.fn = ctx;
    this.skipEol();
    if (this.is('{')) this.i++; else this.problem(this.peek(), 'Expected "{"');
    const bodyStart = this.i;
    const body = this.blockBody();
    this.fn = outer;
    // assignments to names that are neither parameters nor let: those are program globals in ProvideX
    const known = new Set(locals.map((l) => l.toUpperCase()));
    for (let k = bodyStart; k < this.i; k++) {
      const x = this.toks[k], nx = this.toks[k + 1];
      if (x.kind !== 'ident' || !nx || nx.kind !== 'op' || !['=', '+=', '-=', '*=', '/=', '++', '--'].includes(nx.text)) continue;
      if (!this.atStmtStart(k) || x.text.startsWith('%') || x.text === 'this' || known.has(x.text.toUpperCase())) continue;
      if (this.toks[k - 1]?.kind === 'punct' && this.toks[k - 1].text === '.') continue;
      this.problems.push({ line: x.line, col: x.col, end: x.end, severity: 'warning', message: `${x.text} is not declared with let in ${name}(): it is a program-wide (global) variable` });
      known.add(x.text.toUpperCase());
    }
    const pvxName = 'FN_' + name;
    const head = this.L([{ text: 'DEF ', tok: t }, { text: pvxName, tok: nameTok }, ...(params.length ? [{ text: '(' }, ...params.flatMap((p, i) => [...(i ? [{ text: ',' }] : []), { text: prefix + '.' + p.text, tok: p }]), { text: ')' }] : []), { text: ` ! ${TAG} function` }], t.line);
    const out = [head];
    const loc = [...locals];
    if (ctx.needsFlag) loc.push(prefix + '.ret' + (ctx.str ? '$' : ''), prefix + '.done');
    if (loc.length) out.push(this.L([{ text: `LOCAL ${loc.join(',')} ! ${TAG} locals` }], t.line));
    if (params.length) out.push(this.L([{ text: params.map((p) => `${p.text}=${prefix}.${p.text}`).join('; ') + ` ! ${TAG} params` }], t.line));
    out.push(...body);
    const last = body[body.length - 1];
    if (!last || !last.pieces.some((p) => p.text === 'RETURN')) out.push(this.L([{ text: `RETURN ${ctx.str ? '""' : '0'} ! ${TAG} loopret` }], this.peek(-1).line));
    out.push(this.closing(this.L([{ text: 'END DEF' }], this.peek(-1).line)));
    return out;
  }

  private letStmt() {
    const t = this.next();
    const out: { pieces: Line; src: number }[] = [];
    for (;;) {
      const v = this.peek();
      if (v.kind !== 'ident') { this.problem(v, 'Expected a variable name'); break; }
      this.i++;
      if (this.is('=')) {
        this.i++;
        const e = this.exprUntil((x) => (x.kind === 'punct' && (x.text === ',' || x.text === ';')) || x.kind === 'eol' || x.kind === 'comment', true);
        out.push(this.L([{ text: this.ident(v), tok: v }, { text: '=' }, ...e, { text: ` ! ${TAG} let` }], t.line));
      } else {
        out.push(this.L([{ text: `! ${TAG} let ` }, { text: this.ident(v), tok: v }], t.line));
      }
      if (this.is(',')) { this.i++; continue; }
      break;
    }
    return out;
  }

  /** name [subscripts] followed by = or a compound assignment.  VIA (x)=y / SET_PARAM ('XX')=n are directives. */
  private isAssignment(pieces: Line): boolean {
    const parts = pieces.map((p) => p.text.trim()).filter(Boolean);
    if (parts.length < 2) return false;
    let k = 1;
    if (parts[1] === '[') {
      let d = 0;
      for (; k < parts.length; k++) { if (parts[k] === '[') d++; else if (parts[k] === ']') { d--; if (d === 0) { k++; break; } } }
    }
    return /^(=|\+=|-=|\*=|\/=|\^=)$/.test(parts[k] ?? '');
  }

  // ---------------------------------------------------------------- expressions
  private ident(t: TsToken): string {
    if (t.text === 'this') return '_OBJ';
    return t.text.replace(/::/g, '.');
  }

  /** Expression up to the end of the statement (';', end of line outside brackets, or a comment). */
  exprUntilEnd(directive = false): Line {
    return this.exprUntil((x) => (x.kind === 'punct' && (x.text === ';' || x.text === '}')) || x.kind === 'eol' || x.kind === 'comment', false, false, directive);
  }

  /**
   * Translates tokens until `stop` matches at bracket depth 0.
   * `inner`: the stop token is a closing bracket of an enclosing group (stop applies at depth 0 only).
   * `blockStop`: stop at '{' that opens a block (not a {1:2} subscript).
   */
  exprUntil(stop: (t: TsToken) => boolean, inner = false, blockStop = false, directive = false): Line {
    const out: Line = [];
    let depth = 0;
    let prev: TsToken | undefined;
    let first = true;
    for (;;) {
      const t = this.peek();
      if (this.atEnd()) break;
      if (t.kind === 'eol' && depth > 0) { this.i++; continue; } // expressions may span lines inside brackets
      if (depth === 0 && stop(t)) {
        if (!(blockStop && t.text === '{' && isSubscript(prev, t))) break;
      }
      if (t.kind === 'eol') break;
      this.i++;
      const space = prev && (t.col > prev.end || t.line !== prev.line) ? ' ' : '';
      if (t.kind === 'punct' && (t.text === '(' || t.text === '[' || (t.text === '{' && isSubscript(prev, t)))) depth++;
      if (t.kind === 'punct' && (t.text === ')' || t.text === ']' || (t.text === '}' && depth > 0))) depth--;
      void inner;
      switch (t.kind) {
        case 'string': out.push({ text: space }, { text: t.hex ? hexLiteral(t.value ?? '') : pvxString(t.value ?? ''), tok: t }); break;
        case 'raw': out.push({ text: space }, { text: t.value ?? '', tok: t }); break;
        case 'ident': {
          const low = t.text.toLowerCase();
          // new Class(args)  ->  NEW("Class", args)
          if (low === 'new' && this.peek().kind === 'ident' && this.is('(', 1)) {
            const cls = this.next();
            this.i++; // (
            depth++;
            out.push({ text: space }, { text: 'NEW(', tok: t }, { text: '"' + cls.text + '"', tok: cls });
            if (!this.is(')')) out.push({ text: ',' });
            prev = cls; first = false;
            continue;
          }
          // global.NAME  ->  %NAME
          if (low === 'global' && this.is('.') && this.peek().col === t.end && this.peek(1).kind === 'ident') {
            this.i++;
            const g = this.next();
            out.push({ text: space }, { text: '%' + g.text.replace(/::/g, '.'), tok: g });
            prev = g; first = false;
            continue;
          }
          // (keywords keep the case they were written in: ProvideX ignores keyword case)
          if (low === 'and' || low === 'or') { out.push({ text: ' ' + low.toUpperCase() + ' ', tok: t }); break; }
          const fn = this.functions.get(t.text.toUpperCase());
          if (fn && this.is('(')) { out.push({ text: space }, { text: fn, tok: t }); break; }
          if (fn && !this.is('(')) { out.push({ text: space }, { text: fn, tok: t }); break; }
          out.push({ text: space }, { text: this.ident(t), tok: t });
          break;
        }
        case 'op': {
          const map: Record<string, string> = { '==': '=', '===': '=', '!=': '<>', '!==': '<>', '&&': ' AND ', '||': ' OR ', '**': '^' };
          if (t.text === '!') {
            // !x -> NOT(x)   !(x) -> NOT(x)
            if (this.is('(')) { out.push({ text: space }, { text: 'NOT', tok: t }); break; }
            out.push({ text: space }, { text: 'NOT(', tok: t }, ...this.primary(), { text: ')' });
            break;
          }
          const m = map[t.text];
          out.push(m ? { text: m.startsWith(' ') ? m : space + m, tok: t } : { text: space + t.text, tok: t });
          break;
        }
        case 'punct':
          // f(a, { err: *NEXT })  ->  f(a,ERR=*NEXT)
          if (t.text === '{' && prev && prev.kind === 'punct' && prev.text === ',' && (this.peek().kind === 'ident' || this.peek().kind === 'eol') ) {
            if (isSubscript(prev, t)) depth--; // counted as a subscript opener above
            const entries = this.objectEntries();
            entries.forEach((e2, n) => out.push(...(n ? [{ text: ',' }] : []), { text: e2.key.toUpperCase() + '=', tok: e2.tok }, ...e2.value));
            prev = this.peek(-1); first = false;
            continue;
          }
          if (t.text === '.' && this.peek().kind === 'ident' && prev && t.col === prev.end) {
            const m = this.next();
            out.push({ text: "'" }, { text: m.text.replace(/::/g, '.'), tok: m });
            prev = m; // so a chained .Member keeps the adjacency check working
            first = false;
            continue;
          }
          if (t.text === '.' && prev && t.col === prev.end && (prev.kind === 'ident' || prev.text === ')' || prev.text === ']') && this.peek().kind !== 'ident' && !(this.peek().kind === 'op' && this.peek().text === '*')) {
            // "obj." while typing: keep it a member access so member completion applies
            out.push({ text: "'", tok: t });
            prev = t; first = false;
            continue;
          }
          if (t.text === '.' && this.peek().kind === 'op' && this.peek().text === '*' && prev && t.col === prev.end) {
            const m = this.next(); // obj.*  ->  obj'*  (all properties)
            out.push({ text: "'*", tok: m });
            prev = m; first = false;
            continue;
          }
          out.push({ text: (t.text === '(' || t.text === ')' || t.text === ',' || t.text === ']' || t.text === '[') ? '' : space }, { text: t.text, tok: t });
          break;
        default: out.push({ text: space }, { text: t.text, tok: t });
      }
      prev = t;
      first = false;
    }
    return out;
  }

  /** A primary expression for unary '!': identifier/literal with calls, subscripts and member accesses. */
  private primary(): Line {
    const out: Line = [];
    const t = this.peek();
    if (this.is('(')) {
      this.i++;
      out.push({ text: '(' }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === ')', true), { text: ')' });
      if (this.is(')')) this.i++;
      return out;
    }
    if (t.kind === 'op' && t.text === '!') { this.i++; return [{ text: 'NOT(', tok: t }, ...this.primary(), { text: ')' }]; }
    const isGlobal = t.kind === 'ident' && t.text === 'global' && this.is('.', 1) && this.peek(2).kind === 'ident';
    if (isGlobal) { this.i += 2; const g = this.next(); out.push({ text: '%' + g.text.replace(/::/g, '.'), tok: g }); }
    else this.i++;
    if (isGlobal) { /* members follow below */ }
    else if (t.kind === 'ident') {
      const fn = this.functions.get(t.text.toUpperCase());
      out.push({ text: fn ?? this.ident(t), tok: t });
    } else if (t.kind === 'string') out.push({ text: t.hex ? hexLiteral(t.value ?? '') : pvxString(t.value ?? ''), tok: t });
    else out.push({ text: t.text, tok: t });
    for (;;) {
      if (this.is('(') || this.is('[')) {
        const open = this.next();
        const close = open.text === '(' ? ')' : ']';
        out.push({ text: open.text, tok: open }, ...this.exprUntil((x) => x.kind === 'punct' && x.text === close, true));
        if (this.is(close)) out.push({ text: close, tok: this.next() });
        continue;
      }
      if (this.is('.') && this.peek(1).kind === 'ident') { this.i++; const m = this.next(); out.push({ text: "'" }, { text: m.text.replace(/::/g, '.'), tok: m }); continue; }
      break;
    }
    return out;
  }
}

function isSubscript(prev: TsToken | undefined, t: TsToken): boolean {
  return !!prev && prev.line === t.line && prev.end === t.col && (prev.kind === 'ident' || (prev.kind === 'punct' && (prev.text === ']' || prev.text === ')')));
}
