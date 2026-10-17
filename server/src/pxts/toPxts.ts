// ProvideX (readable form: one statement per line, blocks expanded) -> ProvideX/TS (.pxts).
//
// The translation is a re-skin: every construct maps 1:1 back to ProvideX (see fromPxts.ts). Anything without a
// structured TS form (unbalanced FOR/NEXT, GOTO-into-loop code, unknown statements) is kept verbatim as pvx`...`.
// Generated scaffolding for TS-only features (functions with local scope, return from loops, let) is tagged in the
// ProvideX code with "! @pxts ..." comments, so it folds back into the TS form when translated again.
import { parse, ParsedDoc, Stmt } from '../parser';
import { T, Token, lexLine } from '../lexer';
import { tsString, tsHex } from './lexer';

export const TAG = '@pxts';

/** Default label of a method: SetUIHandle -> SET_UI_HANDLE (a different label is shown as @label(X)). */
export function upperSnake(name: string): string {
  return name.replace(/[$%]$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toUpperCase();
}

const BLOCK_END = new Map<string, string>([['FOR', 'NEXT'], ['WHILE', 'WEND'], ['REPEAT', 'UNTIL'], ['SWITCH', 'END SWITCH'], ['SELECT', 'NEXT RECORD'], ['TRY', 'END_TRY'], ['DEF CLASS', 'END DEF'], ['DEF FN', 'END DEF']]);

/** structured: lines of openers/closers that nest properly; closerOf: opener line -> its closer line */
interface Pairing { structured: Set<number>; closerOf: Map<number, number> }

function hexValue(t: Token): string {
  const h = t.text.slice(1, -1);
  let v = '';
  for (let i = 0; i + 1 < h.length; i += 2) v += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return v;
}

function strValue(t: Token): string { return t.text.slice(1, t.unterminated ? undefined : -1).replace(/""/g, '"'); }

export interface ToPxtsResult { text: string; warnings: string[] }

/** Converts readable ProvideX text to .pxts. */
export function toPxts(pvx: string): ToPxtsResult {
  const doc = parse(pvx);
  const tr = new Translator(doc);
  return { text: tr.run(), warnings: tr.warnings };
}

class Translator {
  out: string[] = [];
  warnings: string[] = [];
  indent = 0;
  pairing: Pairing;
  modernFns = new Map<string, { tsName: string; prefix: string }>(); // FN_x$ -> x$
  inModernFn?: { prefix: string; tsName: string };
  classDepth = -1;
  forceRaw = new Set<number>();
  /** inside DEF CLASS ... END DEF (header declarations become TS class members) */
  inClass = false;
  /** GET:NAME / SET:NAME -> label, for the properties written as fields with @get/@set */
  private accessorLabels = new Map<string, string>();
  /** LIKE statements lifted into "extends" */
  liftedLike = new Set<number>();

  constructor(public doc: ParsedDoc) {
    this.pairing = pairBlocks(doc);
    // tagged (modern) functions: DEF FN_name(...) ! @pxts function
    doc.lexed.forEach((lx) => {
      const toks = lx.tokens;
      const c = toks.find((t) => t.kind === T.Comment);
      if (!c || !c.text.includes(TAG + ' function')) return;
      const fn = toks.find((t) => t.kind === T.Word && /^FN_/i.test(t.text));
      if (fn) this.modernFns.set(fn.upper, { tsName: fn.text.slice(3), prefix: 'px_' + fn.text.slice(3).replace(/[$%]$/, '') });
    });
  }

  emit(s: string) { this.out.push(s === '' ? '' : '  '.repeat(Math.max(0, this.indent)) + s); }

  run(): string {
    const lines = this.doc.lines;
    for (let i = 0; i < lines.length; i++) {
      const stmts = this.doc.stmtsByLine[i];
      const cls = stmts.find((st) => st.kind === 'DEF CLASS');
      if (cls && stmts.length === 1 && this.pairing.structured.has(i)) {
        const next = this.emitClass(i);
        if (next !== undefined) { i = next - 1; continue; }
      }
      if (!stmts.length) { if (!lines[i].trim() || /^\s*\d+\s*$/.test(lines[i])) this.emit(''); continue; }
      this.line(i, stmts);
    }
    return this.out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  /** Comment token of a statement list (trailing comment of the line). */
  private splitComment(toks: Token[]): { toks: Token[]; comment?: string } {
    if (toks.length === 2 && toks[0].upper === 'REM' && toks[1].kind === T.Comment) return { toks: [], comment: 'REM' + toks[1].text };
    if (toks.length === 1 && toks[0].upper === 'REM') return { toks: [], comment: 'REM' };
    const last = toks[toks.length - 1];
    if (last && last.kind === T.Comment) return { toks: toks.slice(0, -1), comment: last.text.replace(/^!\s?/, '') };
    if (toks.length >= 2 && toks[0].upper === 'REM' && toks[1].kind === T.Comment) return { toks: [], comment: toks[1].text.replace(/^\s/, '') };
    return { toks };
  }

  private line(i: number, stmts: Stmt[]) {
    const src = this.doc.lines[i];
    // syntax-error lines and raw lines are kept verbatim
    if (/!\s*<- ProvideX reported a syntax error/.test(src)) { this.emit('pvx`' + src.trim() + '`;'); return; }
    // modern-function scaffolding
    const allToks = stmts.flatMap((s) => s.tokens);
    const tagC = allToks.find((t) => t.kind === T.Comment && t.text.includes(TAG));
    if (tagC && this.scaffold(i, allToks, tagC)) return;

    for (let k = 0; k < stmts.length; k++) {
      const st = stmts[k];
      const next = stmts[k + 1];
      // "} ELSE {" / "} ELSE IF c THEN {" become one line
      if (st.kind === 'BLOCK_CLOSE' && next && next.tokens[0]?.upper === 'ELSE') {
        this.indent--;
        const rest = this.splitComment(next.tokens);
        const elseToks = rest.toks.slice(1);
        const tail = rest.comment ? ' // ' + rest.comment : '';
        if (elseToks.length && elseToks[0].upper === 'IF' && isPunct(elseToks[elseToks.length - 1], '{')) {
          const thenIdx = elseToks.findIndex((t) => t.upper === 'THEN');
          this.emit('} else if (' + this.cond(elseToks.slice(1, thenIdx)) + ') {' + tail);
        } else if (elseToks.length === 1 && isPunct(elseToks[0], '{')) this.emit('} else {' + tail);
        else { this.emit('} else ' + this.inlineBlock(elseToks) + tail); k++; continue; }
        this.indent++;
        k++;
        continue;
      }
      // "} ! comment"
      if (st.kind === 'BLOCK_CLOSE' && next && next.tokens.length === 1 && next.tokens[0].kind === T.Comment) {
        this.indent--;
        this.emit('} // ' + next.tokens[0].text.replace(/^!\s?/, ''));
        k++;
        continue;
      }
      // "IF x THEN { ! note": the comment stays on the opening line
      if (next && next.tokens.length === 1 && next.tokens[0].kind === T.Comment && st.tokens.length && isPunct(st.tokens[st.tokens.length - 1], '{')) {
        this.statement(i, { ...st, tokens: [...st.tokens, next.tokens[0]] });
        k++;
        continue;
      }
      this.statement(i, st);
    }
  }

  private statement(line: number, st: Stmt) {
    const { toks, comment } = this.splitComment(st.tokens);
    const tail = comment !== undefined ? (toks.length ? ' // ' + comment : '// ' + comment) : '';
    if (!toks.length) { this.emit(tail.trim()); return; }
    const kind = st.kind;
    // tokens the lexer could not classify: keep the statement verbatim
    if (toks.some((t) => t.kind === T.Unknown)) { this.emit('pvx`' + this.doc.lines[line].slice(toks[0].start, toks[toks.length - 1].end) + '`;' + (tail ? ' ' + tail : '')); return; }
    const structured = this.pairing.structured.has(line) && !this.forceRaw.has(line);
    const head = toks.slice(1);
    switch (kind) {
      case 'LABEL': this.emit(toks[0].text + ':' + (tail ? ' ' + tail : '')); return;
      case 'BLOCK_CLOSE': this.indent--; this.emit('}' + (tail ? ' ' + tail : '')); return;
      case 'FOR':
        if (!structured) break;
        {
          const toIdx = head.findIndex((t) => t.upper === 'TO');
          const stepIdx = head.findIndex((t) => t.upper === 'STEP');
          const eq = head.findIndex((t) => t.text === '=');
          if (toIdx < 0 || eq < 0) break;
          const v = this.expr(head.slice(0, eq));
          const from = this.expr(head.slice(eq + 1, toIdx));
          const to = this.expr(head.slice(toIdx + 1, stepIdx < 0 ? head.length : stepIdx));
          const stepToks = stepIdx < 0 ? [] : head.slice(stepIdx + 1);
          const lit = stepToks.length === 1 && stepToks[0].kind === T.Number ? stepToks[0].text
            : stepToks.length === 2 && stepToks[0].text === '-' && stepToks[1].kind === T.Number ? '-' + stepToks[1].text : undefined;
          // ProvideX FOR evaluates the bounds once and counts towards TO by STEP (inclusive)
          if (stepIdx < 0) this.emit(`for (${v} = ${from}; ${v} <= ${to}; ${v}++) {` + (tail ? ' ' + tail : ''));
          else if (lit !== undefined && !lit.startsWith('-')) this.emit(`for (${v} = ${from}; ${v} <= ${to}; ${v} += ${lit}) {` + (tail ? ' ' + tail : ''));
          else if (lit !== undefined) this.emit(`for (${v} = ${from}; ${v} >= ${to}; ${v} ${lit === '-1' ? '--' : '-= ' + lit.slice(1)}) {` + (tail ? ' ' + tail : ''));
          else this.emit(`for (${v} = ${from} to ${to} step ${this.expr(stepToks)}) {` + (tail ? ' ' + tail : ''));
          this.indent++;
          return;
        }
      case 'NEXT': case 'WEND': case 'END SWITCH': case 'NEXT RECORD': case 'END_TRY':
        if (!structured) break;
        this.indent--; this.emit('}' + (tail ? ' ' + tail : '')); return;
      case 'END DEF':
        if (!structured) break;
        this.indent--; this.emit('}' + (tail ? ' ' + tail : ''));
        if (this.inModernFn) this.inModernFn = undefined;
        else this.inClass = false;
        return;
      case 'WHILE':
        if (!structured) break;
        this.emit(`while (${this.cond(head)}) {` + (tail ? ' ' + tail : '')); this.indent++; return;
      case 'REPEAT':
        if (!structured) break;
        this.emit('repeat {' + (tail ? ' ' + tail : '')); this.indent++; return;
      case 'UNTIL':
        if (!structured) break;
        this.indent--; this.emit(`} until (${this.cond(head)});` + (tail ? ' ' + tail : '')); return;
      case 'SWITCH':
        if (!structured) break;
        this.emit(`switch (${this.cond(head)}) {` + (tail ? ' ' + tail : '')); this.indent++; return;
      case 'CASE': {
        const relational = head[0]?.kind === T.Operator;
        const labels = relational ? [head] : splitTopLevelComma(head);
        this.out.push('  '.repeat(Math.max(0, this.indent - 1)) + labels.map((p) => `case ${this.expr(p, true)}:`).join(' ') + (tail ? ' ' + tail : ''));
        return;
      }
      case 'DEFAULT': this.out.push('  '.repeat(Math.max(0, this.indent - 1)) + 'default:' + (tail ? ' ' + tail : '')); return;
      case 'SELECT':
        if (!structured) break;
        this.emit(`select ${this.selectHeader(head)} {` + (tail ? ' ' + tail : '')); this.indent++; return;
      case 'TRY':
        if (isPunct(toks[toks.length - 1], '{')) { this.emit('try {' + (tail ? ' ' + tail : '')); this.indent++; return; }
        if (!structured) break;
        this.emit('try {' + (tail ? ' ' + tail : '')); this.indent++; return;
      case 'CATCH': case 'FINALLY':
        if (isPunct(toks[toks.length - 1], '{')) {
          const args = head.slice(0, -1);
          this.emit(`${kind.toLowerCase()}${args.length ? ' (' + this.expr(args) + ')' : ''} {` + (tail ? ' ' + tail : ''));
          this.indent++;
          return;
        }
        this.indent--;
        this.emit(`} ${kind.toLowerCase()}${head.length ? ' (' + this.expr(head) + ')' : ''} {` + (tail ? ' ' + tail : ''));
        this.indent++;
        return;
      case 'DEF CLASS': {
        if (!structured) break;
        const nameTok = toks[2];
        const name = nameTok && nameTok.kind === T.String && /^[A-Za-z_][A-Za-z0-9_]*$/.test(strValue(nameTok)) ? strValue(nameTok) : nameTok ? this.expr([nameTok]) : '';
        // CREATE [label] [REQUIRED] / DELETE [label] [REQUIRED]  ->  @create(label, required) / @delete(...)
        const rest = toks.slice(3);
        const decos: string[] = [];
        let k = 0, odd = false;
        while (k < rest.length) {
          const w = rest[k];
          if (w.kind === T.Word && (w.upper === 'CREATE' || w.upper === 'DELETE')) {
            const args: string[] = [];
            k++;
            if (rest[k]?.kind === T.Word && rest[k].upper !== 'REQUIRED' && rest[k].upper !== 'CREATE' && rest[k].upper !== 'DELETE') args.push(rest[k++].text);
            if (rest[k]?.kind === T.Word && rest[k].upper === 'REQUIRED') { args.push('required'); k++; }
            decos.push(`@${w.upper.toLowerCase()}(${args.join(', ')})`);
            continue;
          }
          odd = true; break;
        }
        if (odd) decos.push('@pvx(' + tsString(joinSrc(rest)) + ')');
        // LIKE "A","B" statements of the class header become  extends A, B
        const end = this.pairing.closerOf.get(line) ?? line;
        const parents: string[] = [];
        for (let l = line + 1; l < end; l++) for (const st2 of this.doc.stmtsByLine[l]) {
          if (st2.kind !== 'LIKE') continue;
          const names = st2.tokens.filter((t) => t.kind === T.String).map((t) => strValue(t));
          if (!names.every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) continue;
          parents.push(...names);
          this.liftedLike.add(l);
        }
        for (const d of decos) this.emit(d);
        this.emit(`class ${name}${parents.length ? ' extends ' + parents.join(', ') : ''} {` + (tail ? ' ' + tail : ''));
        this.indent++;
        this.inClass = true;
        return;
      }
      case 'LIKE':
        if (this.liftedLike.has(line)) { if (tail) this.emit(tail.trim()); return; }
        this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : '')); return;
      case 'PROPERTY': {
        const m = this.inClass ? this.propertyMember(head) : undefined;
        if (!m) { this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : '')); return; }
        this.emit(m + ';' + (tail ? ' ' + tail : ''));
        return;
      }
      case 'LOCAL':
        if (!this.inClass) { this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : '')); return; }
        this.emit('private ' + this.expr(head) + ';' + (tail ? ' ' + tail : ''));
        return;
      case 'DEF': {
        // single-line  DEF FNX(A)=expr   -> def FNX(A) => expr;
        // multi-line   DEF FNX(A)        -> def FNX(A) {
        const eqIdx = head[0] && /^FN/i.test(head[0].text) ? topLevelIndex(head, (t) => t.text === '=') : -2;
        if (eqIdx === -2) { this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : '')); return; } // DEF OBJECT, DEF ERR=...: plain statement
        if (eqIdx >= 0) {
          const name = head[0].text;
          const params = isPunct(head[1], '(') ? this.expr(head.slice(1, eqIdx)) : '()';
          this.emit(`const ${name} = ${params} => ${this.expr(head.slice(eqIdx + 1), true)};` + (tail ? ' ' + tail : ''));
          return;
        }
        if (!structured) break;
        this.emit(`def ${this.expr(head)} {` + (tail ? ' ' + tail : '')); this.indent++;
        return;
      }
      case 'FUNCTION': {
        const m = this.inClass ? this.methodMember(head) : undefined;
        if (!m) break;
        this.emit(m + (tail ? ' ' + tail : ''));
        return;
      }
      case 'ELSE':
        // ELSE on its own line after a closing brace ("}" then "ELSE stmt")
        if (head.length && !isPunct(head[head.length - 1], '{')) { this.emit('else ' + this.inlineBlock(head) + (tail ? ' ' + tail : '')); return; }
        break;
      case 'IF': {
        this.emitIf(toks, tail);
        return;
      }
      case 'LET': case 'CALL_METHOD': case 'EXPR':
        this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : ''));
        return;
      case 'BLOCK_OPEN':
        this.emit('{' + (tail ? ' ' + tail : '')); this.indent++; return;
      default:
        this.emit(this.inlineStmt(toks) + (tail ? ' ' + tail : ''));
        return;
    }
    // unstructured: keep the ProvideX statement verbatim -- and then its closer as well, or the TS braces
    // would close the wrong block (e.g. FOR without TO keeps its NEXT)
    const closer = this.pairing.closerOf.get(line);
    if (closer !== undefined) this.forceRaw.add(closer);
    this.emit('pvx`' + this.doc.lines[line].slice(toks[0].start, toks[toks.length - 1].end) + '`;' + (tail ? ' ' + tail : ''));
  }

  /**
   * A class with its method bodies:  DEF CLASS ... FUNCTION Name(args)LABEL ... END DEF  LABEL: ENTER args ... RETURN
   * becomes  class X { Name(args) { ... } }.  Sections keep their order, so the ProvideX layout is restored exactly
   * on the way back. Returns the line after the class implementation, or undefined when the class does not fit.
   */
  private emitClass(L: number): number | undefined {
    const doc = this.doc;
    const E = this.pairing.closerOf.get(L);
    if (E === undefined) return undefined;
    let regionEnd = doc.lines.length;
    for (let l = E + 1; l < doc.lines.length; l++) if (doc.stmtsByLine[l].some((st) => st.kind === 'DEF CLASS')) { regionEnd = l; break; }
    const cls = doc.classes.find((c) => c.span.line === L);
    if (!cls) return undefined;
    const defToks = doc.stmtsByLine[L][0].tokens;
    // labels implemented in this class region
    type Kind = 'method' | 'create' | 'delete' | 'get' | 'set';
    const info = new Map<string, { kind: Kind; decls: { line: number; m: (typeof cls.members)[number] }[]; prop?: string }>();
    const blocked = new Set<string>(); // labels with a declaration that has no TS form
    for (const m of cls.members) {
      // only plain  FUNCTION [LOCAL] Name(args)LABEL  declarations move into the class (not ... FOR EVENT "x")
      const fst = m.kind === 'function' ? doc.stmtsByLine[m.span.line].find((st) => st.kind === 'FUNCTION') : undefined;
      const plainDecl = !!fst && this.methodMember(fst.tokens.slice(1).filter((t) => t.kind !== T.Comment)) !== undefined;
      if (m.kind === 'function' && !plainDecl && m.label) { const k = m.label.toUpperCase(); if (info.get(k)?.kind === 'method') info.delete(k); blocked.add(k); }
      if (m.kind === 'function' && plainDecl && m.label && m.label.toUpperCase() !== 'ERR' && !blocked.has(m.label.toUpperCase())) {
        const k = m.label.toUpperCase();
        const e = info.get(k) ?? { kind: 'method' as Kind, decls: [] };
        e.kind = 'method'; // a label that is also a property's GET/SET handler stays a method
        e.decls.push({ line: m.span.line, m });
        info.set(k, e);
      }
      if (m.kind === 'property') {
        if (m.getLabel && m.getLabel.toUpperCase() !== 'ERR' && !info.has(m.getLabel.toUpperCase())) info.set(m.getLabel.toUpperCase(), { kind: 'get', decls: [], prop: m.name });
        if (m.setLabel && m.setLabel.toUpperCase() !== 'ERR' && !info.has(m.setLabel.toUpperCase())) info.set(m.setLabel.toUpperCase(), { kind: 'set', decls: [], prop: m.name });
      }
    }
    const clauseLabel = (w: string) => {
      const k = defToks.findIndex((t) => t.upper === w);
      const n = k >= 0 ? defToks[k + 1] : undefined;
      return n && n.kind === T.Word && n.upper !== 'REQUIRED' && n.upper !== 'CREATE' && n.upper !== 'DELETE' ? n.upper : undefined;
    };
    info.set(clauseLabel('CREATE') ?? 'ON_CREATE', { kind: 'create', decls: [] });
    info.set(clauseLabel('DELETE') ?? 'ON_DELETE', { kind: 'delete', decls: [] });
    // section starts: method labels defined (once) in the region
    const starts: { line: number; label: string }[] = [];
    for (const [k, defs] of doc.labels) {
      const inRegion = defs.filter((d) => d.span.line > E && d.span.line < regionEnd);
      if (!info.has(k) || !inRegion.length) continue;
      if (defs.length !== 1) return undefined;
      starts.push({ line: inRegion[0].span.line, label: k });
    }
    for (const [k, e] of info) if ((e.kind === 'method' || e.kind === 'get' || e.kind === 'set') && !starts.some((x) => x.label === k)) {
      if (e.kind === 'method') return undefined; // implemented elsewhere (inherited label? another file): keep the ProvideX layout
    }
    if (!starts.length) return undefined;
    starts.sort((a, b) => a.line - b.line);
    // only comments / blank lines between END DEF and the first method
    for (let l = E + 1; l < starts[0].line; l++) if (doc.stmtsByLine[l].some((st) => st.tokens.some((t) => t.kind !== T.Comment && t.upper !== 'REM'))) return undefined;

    // ---- header: comment runs directly above a moved FUNCTION declaration travel with the method
    const moved = new Set<number>();
    const commentsFor = new Map<string, number[]>();
    for (const [k, e] of info) for (const d of e.decls) {
      if (!starts.some((x) => x.label === k)) continue;
      moved.add(d.line);
      const run: number[] = [];
      for (let l = d.line - 1; l > L; l--) {
        const st = doc.stmtsByLine[l];
        if (st.length === 1 && st[0].tokens.length === 1 && st[0].tokens[0].kind === T.Comment && !moved.has(l)) run.unshift(l);
        else break;
      }
      for (const l of run) moved.add(l);
      commentsFor.set(k, [...(commentsFor.get(k) ?? []), ...run]);
    }
    // ---- class line + header members
    this.line(L, doc.stmtsByLine[L]);
    for (let l = L + 1; l < E; l++) {
      if (moved.has(l)) continue;
      const stmts = doc.stmtsByLine[l];
      if (!stmts.length) { this.emit(''); continue; }
      this.line(l, stmts);
    }
    // ---- methods, in the order their sections appear
    const lead: number[] = [];
    for (let l = E + 1; l < starts[0].line; l++) lead.push(l);
    // method bodies are ordinary code (LOCAL there is a statement, not a class member)
    this.inClass = false;
    this.emit('');
    let trailingBlank = 0;
    starts.forEach((sec, n) => {
      const e = info.get(sec.label)!;
      const end = n + 1 < starts.length ? starts[n + 1].line : regionEnd;
      // trailing comments / blank lines of a section belong between methods
      let lastCode = sec.line;
      for (let l = sec.line; l < end; l++) if (doc.stmtsByLine[l].some((st) => st.tokens.some((t) => t.kind !== T.Comment) && st.kind !== 'EMPTY')) lastCode = l;
      for (const l of [...(n === 0 ? lead : []), ...(commentsFor.get(sec.label) ?? [])]) {
        const st = doc.stmtsByLine[l];
        if (st.length) this.line(l, st); else this.emit('');
      }
      // ENTER a, b$  ->  parameters
      const labelStmts = doc.stmtsByLine[sec.line].filter((st) => st.kind !== 'LABEL');
      let bodyFirstLine = sec.line;
      let enterStmt: Stmt | undefined = labelStmts[0];
      if (!enterStmt) {
        for (let l = sec.line + 1; l <= lastCode; l++) { const st = doc.stmtsByLine[l]; if (st.length) { enterStmt = st[0]; bodyFirstLine = l; break; } }
      }
      let params = '';
      let skip: Stmt | undefined;
      if (enterStmt && enterStmt.kind === 'ENTER' && !enterStmt.tokens.some((t) => t.kind === T.Comment)) {
        let ps = enterStmt.tokens.slice(1);
        // ENTER ..., ERR=*NEXT makes the arguments optional
        let optional = false;
        const n = ps.length;
        if (n >= 4 && isPunct(ps[n - 4], ',') && ps[n - 3].upper === 'ERR' && ps[n - 2].text === '=' && ps[n - 1].kind === T.Special && ps[n - 1].upper === '*NEXT') { optional = true; ps = ps.slice(0, n - 4); }
        const plain = ps.length > 0 && ps.every((t, k) => (k % 2 === 0 ? t.kind === T.Word : isPunct(t, ',')));
        if (plain) { params = ps.filter((t) => t.kind === T.Word).map((t) => this.expr([t]) + (optional ? '?' : '')).join(', '); skip = enterStmt; }
      }
      const name = (m: { name: string }) => m.name.replace(/\./g, '::');
      const labelDeco = (label: string, def: string) => (label !== def ? `@label(${label}) ` : '');
      const flags = (m: { local: boolean; perform?: boolean }) => (m.perform ? '@perform ' : '') + (m.local ? 'private ' : '');
      let headLine: string;
      if (e.kind === 'create') headLine = `constructor(${params}) {`;
      else if (e.kind === 'delete') headLine = `destructor(${params}) {`;
      else if (e.kind === 'get') headLine = `get ${e.prop}(${params}) {`;
      else if (e.kind === 'set') headLine = `set ${e.prop}(${params}) {`;
      else {
        const d0 = e.decls[0].m;
        // parameters as written in the FUNCTION statement (also  FUNCTION PROCESS(*) )
        const declParams = (m: { span: { line: number } }) => {
          const st = doc.stmtsByLine[m.span.line].find((x) => x.kind === 'FUNCTION');
          const tk = st ? st.tokens : [];
          const o = tk.findIndex((t) => isPunct(t, '('));
          if (o < 0) return '';
          let d = 0, c = o;
          for (; c < tk.length; c++) { if (isPunct(tk[c], '(')) d++; else if (isPunct(tk[c], ')')) { d--; if (d === 0) break; } }
          return splitTopLevelComma(tk.slice(o + 1, c)).map((p) => this.expr(p)).join(', ');
        };
        // a comment on a declaration line stays on its signature
        const declComment = (l: number) => { const c = doc.stmtsByLine[l].flatMap((st) => st.tokens).find((t) => t.kind === T.Comment); return c ? ' // ' + c.text.replace(/^!\s?/, '') : ''; };
        const single = e.decls.length === 1 && declParams(d0).toUpperCase() === params.toUpperCase() && !declComment(e.decls[0].line);
        if (!single) for (const d of e.decls) this.emit(`${flags(d.m)}${name(d.m)}(${declParams(d.m)});${declComment(d.line)}`);
        headLine = `${labelDeco(sec.label, upperSnake(d0.name))}${single ? flags(d0) : flags(d0)}${name(d0)}(${params}) {`;
      }
      // get/set: the label ProvideX/TS derives (from the field's @get/@set, else GET_/SET_NAME) must be this one
      if (e.kind === 'get' || e.kind === 'set') {
        const derived = this.accessorLabels.get(e.kind.toUpperCase() + ':' + (e.prop ?? '').toUpperCase()) ?? e.kind.toUpperCase() + '_' + upperSnake(e.prop ?? '');
        if (derived.toUpperCase() !== sec.label) headLine = `@label(${sec.label}) ` + headLine;
      }
      if (e.kind === 'create' && sec.label !== (clauseLabel('CREATE') ?? 'ON_CREATE')) headLine = `@label(${sec.label}) ` + headLine;
      if (e.kind === 'delete' && sec.label !== (clauseLabel('DELETE') ?? 'ON_DELETE')) headLine = `@label(${sec.label}) ` + headLine;
      // a comment on the label line goes on the method line
      const labelComment = doc.stmtsByLine[sec.line].flatMap((st) => st.tokens).find((t) => t.kind === T.Comment && t.text.startsWith('!'));
      this.emit(headLine + (labelComment && !labelStmts.some((st) => st.tokens.includes(labelComment)) ? ' // ' + labelComment.text.replace(/^!\s?/, '') : ''));
      this.indent++;
      for (let l = sec.line; l <= lastCode; l++) {
        let stmts = doc.stmtsByLine[l];
        if (l === sec.line) stmts = labelStmts;
        if (skip) stmts = stmts.filter((st) => st !== skip);
        if (!stmts.length) { if (l !== sec.line && l !== bodyFirstLine) this.emit(''); continue; }
        this.line(l, stmts);
      }
      this.indent--;
      this.emit('}');
      // blank lines that end the region belong after the class
      let stop = end;
      if (n === starts.length - 1) while (stop > lastCode + 1 && !doc.stmtsByLine[stop - 1].length) stop--;
      trailingBlank = end - stop;
      for (let l = lastCode + 1; l < stop; l++) {
        const st = doc.stmtsByLine[l];
        if (st.length) this.line(l, st); else this.emit('');
      }
    });
    // END DEF closes the class
    this.indent--;
    const endTail = doc.stmtsByLine[E].flatMap((st) => st.tokens).find((t) => t.kind === T.Comment);
    this.emit('}' + (endTail ? ' // ' + endTail.text.replace(/^!\s?/, '') : ''));
    for (let k = 0; k < trailingBlank; k++) this.emit('');
    this.inClass = false;
    return regionEnd;
  }

  /** PROPERTY a, b$  ->  public a, b$   |   PROPERTY x GET L SET ERR  ->  @get(L) readonly x */
  private propertyMember(head: Token[]): string | undefined {
    const items = splitTopLevelComma(head);
    const parts = items.map((it) => {
      const name = it[0];
      if (!name || name.kind !== T.Word) return undefined;
      let get: string | undefined, set: string | undefined;
      for (let k = 1; k < it.length; k++) {
        const w = it[k].upper;
        if ((w === 'GET' || w === 'SET') && it[k + 1]?.kind === T.Word) { if (w === 'GET') get = it[k + 1].text; else set = it[k + 1].text; k++; continue; }
        return undefined;
      }
      const decos = (get ? `@get(${get.toUpperCase() === 'ERR' ? 'err' : get}) ` : '') + (set && set.toUpperCase() !== 'ERR' ? `@set(${set}) ` : '');
      return { text: decos + (set && set.toUpperCase() === 'ERR' ? 'readonly ' : 'public ') + name.text.replace(/\./g, '::'), plain: !get && !set, name: name.text.toUpperCase(), get, set };
    });
    if (parts.some((p) => !p)) return undefined;
    if (parts.length === 1) {
      const p = parts[0]!;
      if (p.get && p.get.toUpperCase() !== 'ERR') this.accessorLabels.set('GET:' + p.name, p.get.toUpperCase());
      if (p.set && p.set.toUpperCase() !== 'ERR') this.accessorLabels.set('SET:' + p.name, p.set.toUpperCase());
      return p.text;
    }
    if (parts.every((p) => p!.plain)) return 'public ' + items.map((it) => it[0].text.replace(/\./g, '::')).join(', ');
    return undefined;
  }

  /** FUNCTION [LOCAL] [PERFORM] Name(args)LABEL  ->  [@perform] [private] Name(args) => LABEL; */
  private methodMember(head: Token[]): string | undefined {
    let k = 0, local = false, perform = false;
    while (head[k]?.kind === T.Word && (head[k].upper === 'LOCAL' || head[k].upper === 'PERFORM')) { if (head[k].upper === 'LOCAL') local = true; else perform = true; k++; }
    const name = head[k];
    if (!name || name.kind !== T.Word) return undefined;
    k++;
    let params = '';
    if (isPunct(head[k], '(')) {
      let d = 0, e = k;
      for (; e < head.length; e++) { if (isPunct(head[e], '(')) d++; else if (isPunct(head[e], ')')) { d--; if (d === 0) break; } }
      params = this.expr(head.slice(k + 1, e));
      k = e + 1;
    }
    const pre = (perform ? '@perform ' : '') + (local ? 'private ' : '');
    const rest = head.slice(k);
    const nm = name.text.replace(/\./g, '::');
    if (rest.length && rest[0].kind === T.Operator && rest[0].text === '=') return `${pre}${nm}(${params}) { return ${this.expr(rest.slice(1), true)}; }`;
    if (rest.length === 1 && rest[0].kind === T.Word) return `${pre}${nm}(${params}) => ${rest[0].upper === 'ERR' ? 'err' : rest[0].text};`;
    return undefined;
  }

  /** READ (ch,KEY=k$,ERR=*NEXT)a$,b  ->  read({ ch: ch, key: k$, err: *NEXT }, a$, b) */
  private ioCall(toks: Token[]): string | undefined {
    let k = 1;
    let name = toks[0].upper.toLowerCase();
    if (toks[1]?.kind === T.Word && (toks[1].upper === 'RECORD' || (toks[0].upper === 'OPEN' && toks[1].upper === 'LOCK'))) { name += toks[1].upper[0] + toks[1].upper.slice(1).toLowerCase(); k = 2; }
    let head = '';
    if (isPunct(toks[k], '(')) {
      let d = 0, e = k;
      for (; e < toks.length; e++) { if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) d++; else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) { d--; if (d === 0) break; } }
      if (e >= toks.length) return undefined;
      const parts = splitTopLevelComma(toks.slice(k + 1, e));
      if (!parts.length) return undefined;
      const opts: string[] = ['ch: ' + this.expr(parts[0])];
      for (const p of parts.slice(1)) {
        if (!(p[0]?.kind === T.Word && p[0].role === 'fileOption' && p[1]?.kind === T.Operator && p[1].text === '=')) return undefined;
        opts.push(p[0].upper.toLowerCase() + ': ' + this.expr(p.slice(2)));
      }
      head = '{ ' + opts.join(', ') + ' }';
      k = e + 1;
    }
    const argToks = toks.slice(k);
    if (isPunct(argToks[0], ',')) return undefined; // CLOSE (1),(2)
    // anything but plain comma-separated expressions keeps the ProvideX statement form
    let d = 0;
    for (const t of argToks) {
      if (isPunct(t, '(') || isPunct(t, '[')) d++; else if (isPunct(t, ')') || isPunct(t, ']')) d--;
      else if (d === 0 && ((t.kind === T.Operator && t.text === '=') || (t.kind === T.Word && /^(TO|FROM|IOL|RECORD|DATA)$/.test(t.upper)) || isPunct(t, ';'))) return undefined;
    }
    const trailing = argToks.length > 0 && isPunct(argToks[argToks.length - 1], ',');
    const args = splitTopLevelComma(argToks).map((a) => this.expr(a));
    const all = [...(head ? [head] : []), ...args];
    return `${name}(${all.join(', ')}${trailing ? ',' : ''})`;
  }

  private emitIf(toks: Token[], tail: string) {
    // an IF line that still contains END_IF (nested IFs closed mid-line) keeps its exact ProvideX form
    if (toks.some((t) => t.kind === T.Word && (t.upper === 'END_IF' || t.upper === 'FI'))) { this.emit('pvx`' + joinSrc(toks) + '`;' + (tail ? ' ' + tail : '')); return; }
    const thenIdx = topLevelIndex(toks, (t) => t.upper === 'THEN');
    if (thenIdx < 0) { this.emit('pvx`' + toks.map((t) => t.text).join(' ') + '`;' + tail); return; }
    const cond = this.cond(toks.slice(1, thenIdx));
    const rest = toks.slice(thenIdx + 1);
    if (rest.length === 1 && isPunct(rest[0], '{')) { this.emit(`if (${cond}) {` + (tail ? ' ' + tail : '')); this.indent++; return; }
    this.emit(`if (${cond}) ` + this.inlineIfBody(rest) + (tail ? ' ' + tail : ''));
  }

  /** THEN part (and ELSE part) of a single-line IF. */
  private inlineIfBody(rest: Token[]): string {
    const elseIdx = elseIndex(rest);
    const thenPart = elseIdx < 0 ? rest : rest.slice(0, elseIdx);
    const elsePart = elseIdx < 0 ? [] : rest.slice(elseIdx + 1);
    let s = this.inlineBlock(thenPart);
    if (elseIdx >= 0) s += ' else ' + this.inlineBlock(elsePart);
    return s;
  }

  /** One or more ;-separated statements: a single statement, or { a; b; } */
  // (everything after THEN/ELSE is conditional in ProvideX, so several statements become { a; b })
  private inlineBlock(toks: Token[]): string {
    const parts = splitTopLevel(toks);
    if (parts.length === 1) return this.inlineStmt(parts[0]);
    return '{ ' + parts.map((p) => this.inlineStmt(p)).join(' ') + ' }';
  }

  /** A statement on one line, terminated by ';' (or an if ... statement). */
  inlineStmt(toks: Token[]): string {
    if (!toks.length) return ';';
    const first = toks[0];
    const u = first.upper;
    // loop/block statements inside a one-line IF (ELSE { FOR ...; NEXT ... }) have no TS form: keep them verbatim
    if (first.kind === T.Word && first.role === 'directive' && (/^(FOR|NEXT|WHILE|WEND|REPEAT|UNTIL|SWITCH|CASE|DEFAULT|SELECT|TRY|CATCH|FINALLY|END_TRY)$/.test(u) || (u === 'END' && toks[1] && /^(SWITCH|DEF)$/.test(toks[1].upper)) || (u === 'DEF' && toks[1] && toks[1].upper === 'CLASS'))) return 'pvx`' + joinSrc(toks) + '`;';
    if (u === 'REM') return 'pvx`' + joinSrc(toks) + '`;';
    if (u === 'IF' && toks.some((t) => t.kind === T.Word && (t.upper === 'END_IF' || t.upper === 'FI'))) return 'pvx`' + joinSrc(toks) + '`;';
    if (u === 'IF') {
      const thenIdx = topLevelIndex(toks, (t) => t.upper === 'THEN');
      if (thenIdx < 0) return 'pvx`' + joinToks(toks) + '`;';
      const cond = this.cond(toks.slice(1, thenIdx));
      return `if (${cond}) ` + this.inlineIfBody(toks.slice(thenIdx + 1));
    }
    if (first.kind === T.Number && toks.length === 1) return 'goto ' + first.text + ';';
    if (u === 'LET') return this.assignment(toks.slice(1)) + ';';
    if (first.kind === T.Word && first.role !== 'directive' && first.role !== 'clause' && !isDirectiveWord(first)) {
      // assignment or method call
      if (topLevelIndex(toks, (t) => t.kind === T.Operator && /^(=|\+=|-=|\*=|\/=|\^=)$/.test(t.text)) >= 0) return this.assignment(toks) + ';';
      return this.expr(toks) + ';';
    }
    if (first.kind === T.Word && first.role === 'directive' && /^(READ|WRITE|PRINT|INPUT|OPEN|CLOSE|EXTRACT|FIND|REMOVE|UPDATE|INSERT|LOCK|UNLOCK|PURGE)$/.test(u)) {
      const io = this.ioCall(toks);
      if (io) return io + ';';
    }
    if ((u === 'DROP' || u === 'DELETE') && toks[1]?.upper === 'OBJECT') {
      const parts = splitTopLevelComma(toks.slice(2));
      const opts = parts.filter((p) => p[0]?.role === 'fileOption' && p[1]?.text === '=');
      const objs = parts.filter((p) => !opts.includes(p));
      if (opts.length + objs.length === parts.length) return `${u.toLowerCase()}Object(${[...objs.map((p) => this.expr(p)), ...(opts.length ? ['{ ' + opts.map((p) => p[0].upper.toLowerCase() + ': ' + this.expr(p.slice(2))).join(', ') + ' }'] : [])].join(', ')});`;
    }
    if (first.kind === T.Operator && first.text === '?') return 'print ' + this.expr(toks.slice(1)) + ';';
    // directives: lowercase keyword + translated arguments
    const rest = toks.slice(1);
    const kw = u === 'GOTO' || u === 'GOSUB' || u === 'RETURN' || u === 'BREAK' || u === 'CONTINUE' || u === 'END' || u === 'EXIT' || u === 'EXITTO' || u === 'STOP' ? u.toLowerCase() : first.text.toLowerCase();
    const cmpArgs = u === 'RETURN' || u === 'EXIT';
    return kw + (rest.length ? ' ' + this.expr(rest, cmpArgs) : '') + ';';
  }

  private assignment(toks: Token[]): string {
    // targets and values separated by top-level commas:  A=1, B$="x"
    const parts = splitTopLevelComma(toks);
    return parts.map((p) => {
      const eq = topLevelIndex(p, (t) => t.kind === T.Operator && /^(=|\+=|-=|\*=|\/=|\^=)$/.test(t.text));
      if (eq < 0) return this.expr(p);
      return this.expr(p.slice(0, eq)) + ' ' + p[eq].text + ' ' + this.expr(p.slice(eq + 1), true);
    }).join(', ');
  }

  private selectHeader(head: Token[]): string {
    const w = head.findIndex((t) => t.upper === 'WHERE');
    if (w < 0) return this.expr(head);
    return this.expr(head.slice(0, w)) + ' where ' + this.expr(head.slice(w + 1), true);
  }

  /** A condition: like expr(), without a redundant outer pair of parentheses  (IF (x) THEN -> if (x)). */
  cond(toks: Token[]): string {
    if (toks.length >= 2 && isPunct(toks[0], '(') && isPunct(toks[toks.length - 1], ')')) {
      let d = 0, closesAtEnd = true;
      for (let k = 0; k < toks.length; k++) {
        if (isPunct(toks[k], '(') || isPunct(toks[k], '[')) d++;
        else if (isPunct(toks[k], ')') || isPunct(toks[k], ']')) { d--; if (d === 0 && k < toks.length - 1) { closesAtEnd = false; break; } }
      }
      if (closesAtEnd) return this.expr(toks.slice(1, -1), true);
    }
    return this.expr(toks, true);
  }

  /** Translates an expression / argument token list. `compare`: '=' outside parentheses is a comparison. */
  expr(toks: Token[], compare = false): string {
    let s = '';
    let depth = 0;
    let prev: Token | undefined;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      let piece: string;
      // NEW("Class", args)  ->  new Class(args)
      if (t.kind === T.Word && t.upper === 'NEW' && isPunct(toks[k + 1], '(') && toks[k + 2]?.kind === T.String && /^"[A-Za-z_][A-Za-z0-9_]*"$/.test(toks[k + 2].text) && (isPunct(toks[k + 3], ',') || isPunct(toks[k + 3], ')'))) {
        piece = 'new ' + toks[k + 2].text.slice(1, -1) + '(';
        s += spaceBetween(prev, t, s, piece, toks[k - 2]) + piece;
        depth++;
        prev = toks[k + 1];
        k += isPunct(toks[k + 3], ',') ? 3 : 2;
        continue;
      }
      // NOT(x) -> !x for a plain name, !(...) otherwise
      if (t.kind === T.Word && t.upper === 'NOT' && t.role === 'function' && isPunct(toks[k + 1], '(')) {
        let d = 0, e = k + 1;
        for (; e < toks.length; e++) { if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) d++; else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) { d--; if (d === 0) break; } }
        const inner = toks.slice(k + 2, e);
        if (e < toks.length && isPrimaryChain(inner)) {
          piece = '!' + this.expr(inner);
          s += spaceBetween(prev, t, s, piece, toks[k - 2]) + piece;
          prev = toks[e];
          k = e;
          continue;
        }
      }
      // f(a, ERR=*NEXT, END=X) -> f(a, { err: *NEXT, end: X })   (options are always the trailing arguments)
      if (t.kind === T.Word && t.role === 'fileOption' && isPunct(prev, ',') && toks[k + 1]?.text === '=' && depth > 0) {
        let e = k, d = 0;
        const opts: string[] = [];
        let ok = true;
        let cur: Token[] = [];
        for (; e < toks.length; e++) {
          const x = toks[e];
          if (d === 0 && (isPunct(x, ')') || isPunct(x, ','))) {
            if (!(cur[0]?.kind === T.Word && cur[0].role === 'fileOption' && cur[1]?.text === '=')) { ok = false; break; }
            opts.push(cur[0].upper.toLowerCase() + ': ' + this.expr(cur.slice(2)));
            cur = [];
            if (isPunct(x, ')')) break;
            continue;
          }
          if (isPunct(x, '(') || isPunct(x, '[')) d++; else if (isPunct(x, ')') || isPunct(x, ']')) d--;
          cur.push(x);
        }
        if (ok && e < toks.length) {
          piece = '{ ' + opts.join(', ') + ' }';
          s += ' ' + piece;
          prev = toks[e - 1];
          k = e - 1;
          continue;
        }
      }
      switch (t.kind) {
        case T.Mnemonic: piece = 'm`' + t.text.slice(1, -1) + '`'; break;
        case T.String: piece = tsString(strValue(t)); break;
        case T.HexString: piece = tsHex(hexValue(t)); break;
        case T.Member: piece = '.' + t.text.slice(1).replace(/\./g, '::'); break;
        case T.Comment: piece = '// ' + t.text.replace(/^!\s?/, ''); break;
        case T.Operator:
          if (t.text === '=' ) {
            const opt = prev && prev.kind === T.Word && prev.role === 'fileOption';
            piece = !opt && (compare || depth > 0) && !isAssignInArgs(toks, k) ? '==' : '=';
          } else if (t.text === '<>' || t.text === '><') piece = '!=';
          else if (t.text === '=<') piece = '<=';
          else if (t.text === '=>') piece = '>=';
          else if (t.text === '^' || t.text === '**') piece = '**';
          else piece = t.text;
          break;
        case T.Punct:
          if (t.text === '(' || t.text === '[') depth++;
          if (t.text === ')' || t.text === ']') depth--;
          piece = t.subscript ? (t.text === '[' ? '{' : '}') : t.text;
          break;
        case T.Word: piece = this.word(t, toks[k + 1]); break;
        default: piece = t.text;
      }
      s += spaceBetween(prev, t, s, piece, toks[k - 2]) + piece;
      prev = t;
    }
    return s;
  }

  private word(t: Token, next?: Token): string {
    const u = t.upper;
    if (u === '_OBJ') return 'this';
    if (t.role === 'clause' && (u === 'AND' || u === 'OR')) return u === 'AND' ? '&&' : '||';
    if (t.role === 'function' && u === 'NOT' && next && isPunct(next, '(')) return '!';
    if (t.role === 'userFunction') {
      const m = this.modernFns.get(u);
      if (m) return m.tsName;
      return t.text;
    }
    if (t.role === 'function') return t.text.toLowerCase();
    if (t.role === 'directive' || t.role === 'clause' || t.role === 'fileOption') return t.role === 'fileOption' ? t.upper : t.text.toLowerCase();
    if (t.role === 'sysvar') return u;
    // %GLOBAL -> global.GLOBAL
    if (t.text.startsWith('%')) return 'global.' + t.text.slice(1).replace(/\./g, '::');
    // variables: ProvideX dotted names are written with ::
    let name = t.text.replace(/\./g, '::');
    if (this.inModernFn && t.text.toLowerCase().startsWith(this.inModernFn.prefix.toLowerCase() + '.')) name = t.text; // should not happen after folding
    return name;
  }

  /** Recognizes "! @pxts" scaffolding lines. Returns true when the line was handled. */
  private scaffold(line: number, toks: Token[], tagTok: Token): boolean {
    const tag = tagTok.text.slice(tagTok.text.indexOf(TAG) + TAG.length).trim();
    const code = toks.filter((t) => t !== tagTok);
    const word = tag.split(/\s+/)[0];
    switch (word) {
      case 'function': {
        // DEF FN_name$(fn_name.a$,fn_name.b) ! @pxts function
        const fnTok = code.find((t) => /^FN_/i.test(t.text));
        if (!fnTok) return false;
        const info = this.modernFns.get(fnTok.upper)!;
        const params: string[] = [];
        for (const t of code) if (t.kind === T.Word && t.text.toLowerCase().startsWith(info.prefix.toLowerCase() + '.')) params.push(t.text.slice(info.prefix.length + 1));
        this.emit(`function ${info.tsName}(${params.join(', ')}) {`);
        this.indent++;
        this.inModernFn = info;
        return true;
      }
      case 'locals': case 'params': case 'loopret': return true; // regenerated from the TS form
      case 'let': {
        // x=0 ! @pxts let      |   ! @pxts let y$
        const rest = tag.slice(3).trim();
        if (!code.length) { this.emit(`let ${rest};`); return true; }
        const st = this.doc.stmtsByLine[line][0];
        const tk = st.tokens.filter((t) => t.kind !== T.Comment);
        this.emit('let ' + this.assignment(tk[0]?.upper === 'LET' ? tk.slice(1) : tk) + ';');
        return true;
      }
      case 'return': {
        // [IF c THEN ]fn.ret=v; fn.done=1; BREAK ! @pxts return
        const ifIdx = code[0]?.upper === 'IF' ? topLevelIndex(code, (t) => t.upper === 'THEN') : -1;
        const body = ifIdx >= 0 ? code.slice(ifIdx + 1) : code;
        const eq = body.findIndex((t) => t.text === '=');
        const semi = body.findIndex((t) => isPunct(t, ';'));
        const value = eq >= 0 && semi > eq ? this.expr(body.slice(eq + 1, semi), true) : '';
        const ret = 'return' + (value ? ' ' + value : '') + ';';
        if (ifIdx >= 0) this.emit(`if (${this.expr(code.slice(1, ifIdx), true)}) ${ret}`);
        else this.emit(ret);
        return true;
      }
      default: return false;
    }
  }
}

/** name, name.member, name(...), obj.method(...).prop ...: safe operand for a prefix "!" */
function isPrimaryChain(toks: Token[]): boolean {
  if (!toks.length || toks[0].kind !== T.Word) return false;
  let k = 1;
  while (k < toks.length) {
    const t = toks[k];
    if (t.kind === T.Member) { k++; continue; }
    if (isPunct(t, '(') || isPunct(t, '[')) {
      let d = 0;
      for (; k < toks.length; k++) { if (isPunct(toks[k], '(') || isPunct(toks[k], '[')) d++; else if (isPunct(toks[k], ')') || isPunct(toks[k], ']')) { d--; if (d === 0) break; } }
      if (k >= toks.length) return false;
      k++;
      continue;
    }
    return false;
  }
  return true;
}

function isPunct(t: Token | undefined, p: string) { return !!t && t.kind === T.Punct && t.text === p && !t.subscript; }

function isDirectiveWord(t: Token): boolean { return t.role === 'directive'; }

function isAssignInArgs(toks: Token[], k: number): boolean {
  // KEY=..., IOL=... style options keep '='
  const prev = toks[k - 1];
  return !!prev && prev.kind === T.Word && /^(IOL|LEN|REC|KEY|KNO|ERR|END|DOM|IND|TIM|SIZ|BSY|OPT|SEP|TBL|RSZ|BSZ|NBF|ISZ|DIR|FNT|HLP|MNU|MSG|NUL|OWN|RNO|RTY|TIP|FLG|FMT)$/i.test(prev.text) && toks[k - 2] !== undefined && (isPunct(toks[k - 2], ',') || isPunct(toks[k - 2], '('));
}

function topLevelIndex(toks: Token[], pred: (t: Token) => boolean): number {
  let d = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    else if (d === 0 && pred(t)) return k;
  }
  return -1;
}

function elseIndex(toks: Token[]): number {
  let d = 0, nested = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    else if (d === 0 && t.kind === T.Word && t.upper === 'IF') nested++;
    else if (d === 0 && t.kind === T.Word && t.upper === 'ELSE') { if (nested === 0) return k; nested--; }
  }
  return -1;
}

function splitTopLevel(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let d = 0;
  for (const t of toks) {
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    if (d === 0 && isPunct(t, ';') && !(cur.length && cur.some((x) => x.upper === 'IF'))) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

function splitTopLevelComma(toks: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  let d = 0;
  for (const t of toks) {
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    if (d === 0 && isPunct(t, ',')) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  out.push(cur);
  return out.filter((p) => p.length);
}

function joinToks(toks: Token[]): string { return toks.map((t) => t.text).join(' '); }

/** Original source text of a token run (tokens of one line keep their positions). */
function joinSrc(toks: Token[]): string {
  let s = '';
  toks.forEach((t, k) => { s += (k && t.start > toks[k - 1].end ? ' ' : '') + (t.subscript ? (t.text === '[' ? '{' : '}') : t.text); });
  return s;
}

const TIGHT_BEFORE = new Set([')', ']', ',', ';', '.', ':']);
function spaceBetween(prev: Token | undefined, t: Token, soFar: string, piece: string, prev2?: Token): string {
  if (!prev) return '';
  if (t.kind === T.Member) return '';
  if (t.kind === T.Punct && (TIGHT_BEFORE.has(piece) || (t.subscript && piece === '}'))) return '';
  if (t.kind === T.Punct && (piece === '(' || piece === '[' || piece === '{') ) {
    const adj = prev.end === t.start;
    return adj ? '' : ' ';
  }
  if (prev.kind === T.Punct && (prev.text === '(' || prev.text === '[' || (prev.subscript && prev.text === '['))) return '';
  if (prev.kind === T.Punct && prev.text === ',') return ' ';
  if (soFar.endsWith('!') && !soFar.endsWith(' !')) return '';
  if (prev.kind === T.Operator && (prev.text === '++' || prev.text === '--' || prev.text === '@')) return prev.end === t.start ? '' : ' ';
  if (t.kind === T.Operator && (t.text === '++' || t.text === '--')) return prev.end === t.start ? '' : ' ';
  // I/O options stay tight:  ERR=*NEXT, KEY=K$
  if (t.kind === T.Operator && t.text === '=' && prev.kind === T.Word && prev.role === 'fileOption') return '';
  if (prev.kind === T.Operator && prev.text === '=' && /=$/.test(soFar) && /[A-Z]{3}=$/.test(soFar)) return '';
  if (t.kind === T.Operator || prev.kind === T.Operator) {
    // unary minus/plus after an operator or '(' or ','
    const operand = (x?: Token) => !!x && (x.kind === T.Word || x.kind === T.Number || x.kind === T.String || x.kind === T.HexString || x.kind === T.Member || x.kind === T.Mnemonic || (x.kind === T.Punct && (x.text === ')' || x.text === ']')));
    if (prev.kind === T.Operator && (prev.text === '-' || prev.text === '+') && !operand(prev2)) {
      return prev.end === t.start ? '' : ' ';
    }
    return ' ';
  }
  if (t.kind === T.Punct && t.text === ':' ) return '';
  if (prev.kind === T.Punct && prev.text === ':') return prev.end === t.start ? '' : ' ';
  return ' ';
}

/** Marks openers/closers whose pairs nest properly, so they can become { } blocks. */
function pairBlocks(doc: ParsedDoc): Pairing {
  const structured = new Set<number>();
  const closerOf = new Map<number, number>();
  const stack: { kind: string; line: number }[] = [];
  for (let i = 0; i < doc.stmtsByLine.length; i++) {
    for (const st of doc.stmtsByLine[i]) {
      let kind = st.kind;
      if (kind === 'DEF') {
        const eq = st.tokens.some((t) => t.text === '=');
        if (eq || !st.tokens.some((t) => /^FN/i.test(t.text))) continue;
        kind = 'DEF FN';
      }
      const lastTok = st.tokens[st.tokens.length - 1];
      if (kind === 'IF' || kind === 'ELSE' || kind === 'BLOCK_OPEN' || ((kind === 'TRY' || kind === 'CATCH' || kind === 'FINALLY') && lastTok && lastTok.kind === T.Punct && lastTok.text === '{')) {
        if (lastTok && lastTok.kind === T.Punct && lastTok.text === '{' && !lastTok.subscript) stack.push({ kind: '{', line: i });
        continue;
      }
      if (kind === 'BLOCK_CLOSE') {
        const top = stack[stack.length - 1];
        if (top && top.kind === '{') stack.pop();
        else { // braces must always balance in ProvideX; treat mismatch as unstructured region
          const idx = stack.map((s) => s.kind).lastIndexOf('{');
          if (idx >= 0) stack.length = idx;
        }
        continue;
      }
      if (BLOCK_END.has(kind)) { stack.push({ kind, line: i }); continue; }
      const openers = [...BLOCK_END].filter(([, c]) => c === kind).map(([o]) => o);
      if (openers.length) {
        const top = stack[stack.length - 1];
        if (top && openers.includes(top.kind)) {
          // same-line pairs (FOR ...; NEXT) are already split by the readable view
          structured.add(top.line); structured.add(i); closerOf.set(top.line, i);
          stack.pop();
        } else {
          // unbalanced: drop openers above the nearest matching one (they stay pvx`...`)
          const idx = [...stack].reverse().findIndex((s) => openers.includes(s.kind));
          if (idx >= 0) stack.length = stack.length - 1 - idx;
        }
      }
    }
  }
  return { structured, closerOf };
}

export { lexLine };
