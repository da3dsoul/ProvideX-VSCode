// Statement-level parser and symbol collector for ProvideX source.
import { lexLine, LexedLine, T, Token } from './lexer';
import { DIRECTIVES, FUNCTIONS, SYSVARS, FILE_OPTIONS, CLAUSE_WORDS, functionDoc } from './lexicon';

export interface Span { line: number; start: number; end: number }

export interface Stmt {
  line: number;
  tokens: Token[]; // tokens of this statement (no separators)
  head?: Token; // directive token (or the assigned variable for implicit LET)
  kind: string; // upper-cased directive, 'LET' for implicit assignment, 'CALL_METHOD', 'LABEL', 'EMPTY', 'BLOCK_CLOSE'
  /** brace depth at the start of the statement */
  depth: number;
}

export interface LabelDef { name: string; span: Span }
export interface Ref { target: string; kind: 'label' | 'line'; token: Token; line: number; context: string }
export interface VarInfo { name: string; kind: 'number' | 'string' | 'integer' | 'object'; defs: Span[]; refs: Span[]; global: boolean; isParam?: boolean }
export interface FnDef { name: string; span: Span; params: string[]; endLine: number; returns: 'string' | 'number' }
export interface ClassMember { name: string; span: Span; kind: 'property' | 'function'; params?: string[]; label?: string; local: boolean; perform?: boolean; getLabel?: string; setLabel?: string; signature: string }
export interface ClassDef { name: string; span: Span; nameSpan: Span; endLine: number; likes: string[]; members: ClassMember[]; createRequired: boolean; deleteRequired: boolean }
export interface Block { kind: string; startLine: number; endLine: number }
export interface ProgramLink { target: string; entry?: string; span: Span; directive: string }
export interface Problem { span: Span; message: string; severity: 'error' | 'warning' | 'info' | 'hint'; code?: string; data?: unknown }

export interface ParsedDoc {
  text: string;
  lines: string[];
  lexed: LexedLine[];
  stmts: Stmt[];
  stmtsByLine: Stmt[][];
  labels: Map<string, LabelDef[]>;
  lineNumbers: Map<number, number>; // statement number -> line index
  numbered: boolean;
  refs: Ref[];
  vars: Map<string, VarInfo>;
  fns: Map<string, FnDef>;
  classes: ClassDef[];
  blocks: Block[];
  links: ProgramLink[];
  problems: Problem[];
}

const BRANCH_OPTIONS = new Set(['ERR', 'END', 'DOM', 'BSY', 'TIM', 'RTY', 'HLP']);
const BRANCH_TARGET_OPTIONS = new Set(['ERR', 'END', 'DOM', 'BSY']);

function span(line: number, t: Token): Span { return { line, start: t.start, end: t.end }; }

function varKind(name: string): VarInfo['kind'] {
  if (name.endsWith('$')) return 'string';
  if (name.endsWith('%')) return 'integer';
  return 'number';
}

function isWord(t: Token | undefined, w?: string): boolean {
  return !!t && t.kind === T.Word && (w === undefined || t.upper === w);
}
function isPunct(t: Token | undefined, p: string): boolean {
  return !!t && t.kind === T.Punct && t.text === p;
}
function isOp(t: Token | undefined, p?: string): boolean {
  return !!t && t.kind === T.Operator && (p === undefined || t.text === p);
}

/** Splits lexed line tokens into statements (on ';' outside parens, and around { } ). */
function splitStatements(lx: LexedLine, line: number, depthIn: number): { stmts: Stmt[]; depthOut: number } {
  const stmts: Stmt[] = [];
  let cur: Token[] = [];
  let paren = 0;
  let depth = depthIn;
  let stmtDepth = depth;
  const flush = () => {
    if (cur.length) stmts.push({ line, tokens: cur, kind: '', depth: stmtDepth });
    cur = [];
    inIf = false;
    ifDepth = 0;
    stmtDepth = depth;
  };
  let inIf = false;
  let ifDepth = 0;
  for (const t of lx.tokens) {
    if (t.kind === T.LineNumber) continue;
    if (t.kind === T.Word && t.upper === 'IF' && paren === 0) { inIf = true; ifDepth++; }
    else if (t.kind === T.Word && t.upper === 'ELSE' && cur.length === 0) inIf = true;
    // END_IF ends the conditional part of the line only when it closes the outermost IF
    if (inIf && t.kind === T.Word && (t.upper === 'END_IF' || t.upper === 'FI') && paren === 0) { cur.push(t); if (--ifDepth <= 0) { inIf = false; ifDepth = 0; } continue; }
    if (inIf && t.kind === T.Punct && t.text === ';' && paren === 0) { cur.push(t); continue; }
    if (t.kind === T.Punct) {
      if (t.text === '(' || t.text === '[') paren++;
      else if (t.text === ')' || t.text === ']') paren = Math.max(0, paren - 1);
      else if (t.text === ';' && paren === 0) { flush(); continue; }
      else if (t.text === '{' && paren === 0) {
        cur.push(t); flush(); depth++; stmtDepth = depth; continue;
      } else if (t.text === '}' && paren === 0) {
        flush();
        depth = Math.max(0, depth - 1);
        stmts.push({ line, tokens: [t], kind: 'BLOCK_CLOSE', depth });
        stmtDepth = depth;
        continue;
      }
    }
    if (t.kind === T.Label) {
      flush();
      stmts.push({ line, tokens: [t], kind: 'LABEL', head: t, depth });
      continue;
    }
    if (t.kind === T.Punct && t.text === ':' && cur.length === 0 && stmts.length && stmts[stmts.length - 1].kind === 'LABEL') continue;
    cur.push(t);
  }
  flush();
  return { stmts, depthOut: depth };
}

export function parse(text: string): ParsedDoc {
  const lines = text.split(/\r?\n/);
  const doc: ParsedDoc = {
    text, lines, lexed: [], stmts: [], stmtsByLine: [], labels: new Map(), lineNumbers: new Map(), numbered: false,
    refs: [], vars: new Map(), fns: new Map(), classes: [], blocks: [], links: [], problems: [],
  };
  let depth = 0;
  let numberedLines = 0, codeLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const lx = lexLine(lines[i]);
    doc.lexed.push(lx);
    if (lx.tokens.length) codeLines++;
    if (lx.lineNumber) {
      numberedLines++;
      const n = parseInt(lx.lineNumber.text, 10);
      if (doc.lineNumbers.has(n)) {
        doc.problems.push({ span: span(i, lx.lineNumber), message: `Duplicate statement number ${n}`, severity: 'error', code: 'duplicate-line-number' });
      } else doc.lineNumbers.set(n, i);
    }
    const { stmts, depthOut } = splitStatements(lx, i, depth);
    depth = depthOut;
    doc.stmtsByLine.push(stmts);
    doc.stmts.push(...stmts);
    for (const t of lx.tokens) {
      if (t.unterminated) doc.problems.push({ span: span(i, t), message: 'Unterminated string literal', severity: 'error', code: 'unterminated-string' });
    }
  }
  doc.numbered = numberedLines > 0 && numberedLines >= codeLines * 0.5;
  for (const st of doc.stmts) classifyStatement(doc, st);
  analyzeStructure(doc);
  return doc;
}

function addVar(doc: ParsedDoc, line: number, t: Token, def: boolean, isParam = false) {
  let name = t.text;
  const global = name.startsWith('%');
  const key = name.toUpperCase();
  let v = doc.vars.get(key);
  if (!v) {
    v = { name, kind: varKind(name), defs: [], refs: [], global };
    doc.vars.set(key, v);
  }
  if (isParam) v.isParam = true;
  (def ? v.defs : v.refs).push(span(line, t));
}

function addRef(doc: ParsedDoc, st: Stmt, t: Token, context: string) {
  if (t.kind === T.Number) {
    t.role = 'lineRef';
    doc.refs.push({ target: String(parseInt(t.text, 10)), kind: 'line', token: t, line: st.line, context });
  } else if (t.kind === T.Word) {
    t.role = 'labelRef';
    doc.refs.push({ target: t.upper, kind: 'label', token: t, line: st.line, context });
  }
}

/** Classifies a statement's tokens (sets roles) and collects symbols. */
function classifyStatement(doc: ParsedDoc, st: Stmt) {
  const toks = st.tokens.filter((t) => t.kind !== T.Comment);
  if (st.kind === 'LABEL') {
    const t = st.tokens[0];
    t.role = 'labelDef';
    const key = t.upper;
    const arr = doc.labels.get(key) ?? [];
    arr.push({ name: t.text, span: span(st.line, t) });
    doc.labels.set(key, arr);
    return;
  }
  if (st.kind === 'BLOCK_CLOSE') return;
  if (!toks.length) { st.kind = 'EMPTY'; return; }
  let i = 0;
  if (isPunct(toks[0], '{')) { st.kind = 'BLOCK_OPEN'; return; }
  const first = toks[0];
  // statement head
  if (isOp(first, '?')) { st.kind = 'PRINT'; st.head = first; i = 1; }
  else if (first.kind === T.Word) {
    const next = toks[1];
    const assignLike = next && (isOp(next, '=') || isOp(next, '+=') || isOp(next, '-=') || isOp(next, '*=') || isOp(next, '/=') || isOp(next, '^=') || isPunct(next, '['));
    const hasSuffix = /[$%]$/.test(first.text) || first.text.startsWith('%') || first.text.includes('.');
    if (!hasSuffix && DIRECTIVES.has(first.upper) && !(assignLike && !['LET', 'FOR', 'SET_PARAM', 'PRECISION', 'CASE', 'VIA'].includes(first.upper))) {
      st.kind = first.upper; st.head = first; first.role = 'directive'; i = 1;
      // two-word directives
      const w2 = toks[1];
      if (st.kind === 'END' && isWord(w2, 'SWITCH')) { st.kind = 'END SWITCH'; w2.role = 'directive'; i = 2; }
      else if (st.kind === 'END' && isWord(w2, 'DEF')) { st.kind = 'END DEF'; w2.role = 'directive'; i = 2; }
      else if (st.kind === 'END' && isWord(w2, 'IF')) { st.kind = 'END_IF'; w2.role = 'directive'; i = 2; }
      else if (st.kind === 'END' && isWord(w2, 'TRY')) { st.kind = 'END_TRY'; w2.role = 'directive'; i = 2; }
      else if (st.kind === 'ENDDEF') st.kind = 'END DEF';
      else if (st.kind === 'FI') st.kind = 'END_IF';
      else if (st.kind === 'NEXT' && isWord(w2, 'RECORD')) { st.kind = 'NEXT RECORD'; w2.role = 'clause'; i = 2; }
      else if (st.kind === 'DEF' && isWord(w2, 'CLASS')) { st.kind = 'DEF CLASS'; w2.role = 'directive'; i = 2; }
      else if (st.kind === 'DEF' && isWord(w2, 'OBJECT')) { st.kind = 'DEF OBJECT'; w2.role = 'clause'; i = 2; }
      else if (st.kind === 'DROP' && isWord(w2, 'OBJECT')) { st.kind = 'DROP OBJECT'; w2.role = 'clause'; i = 2; }
    } else if (first.kind === T.Word && toks[1]?.kind === T.Member) {
      st.kind = 'CALL_METHOD'; st.head = first;
    } else {
      st.kind = 'LET'; st.head = first;
    }
  } else {
    st.kind = 'EXPR';
  }

  classifyTokens(doc, st, toks, i);
}

function classifyTokens(doc: ParsedDoc, st: Stmt, toks: Token[], from: number) {
  const L = st.line;
  const kind = st.kind;
  // ---- statement specific handling ----
  switch (kind) {
    case 'GOTO': case 'GOSUB': case 'SETERR': case 'SETESC': case 'EXITTO': case 'RETRY': case 'RESTORE': {
      for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word || t.kind === T.Number) {
          // SETERR 0 / SETESC 0 disables the handler; RESTORE with variable is unusual
          if (t.kind === T.Number && parseInt(t.text, 10) === 0 && (kind === 'SETERR' || kind === 'SETESC')) continue;
          if (kind === 'RESTORE' && t.kind === T.Word && !doc.labels.has(t.upper) && /[$%]$/.test(t.text)) continue;
          addRef(doc, st, t, kind);
          break;
        }
      }
      classifyExpr(doc, st, toks, from);
      return;
    }
    case 'DEF CLASS': {
      const nameTok = toks[from];
      const cls: ClassDef = {
        name: nameTok?.kind === T.String ? nameTok.text.slice(1, -1) : nameTok?.text ?? '?',
        span: { line: L, start: toks[0].start, end: toks[toks.length - 1].end },
        nameSpan: nameTok ? span(L, nameTok) : span(L, toks[0]),
        endLine: L, likes: [], members: [], createRequired: false, deleteRequired: false,
      };
      if (nameTok) nameTok.role = 'className';
      for (let k = from + 1; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word) {
          // DEF CLASS "x" CREATE [label] [REQUIRED] DELETE [label] [REQUIRED]
          const prevW = toks[k - 1];
          if ((isWord(prevW, 'CREATE') || isWord(prevW, 'DELETE')) && !/^(REQUIRED|CREATE|DELETE|FOR|PROGRAM)$/.test(t.upper)) { addRef(doc, st, t, 'DEF CLASS'); continue; }
          t.role = 'clause';
          if (t.upper === 'CREATE' && (isWord(toks[k + 1], 'REQUIRED') || isWord(toks[k + 2], 'REQUIRED'))) cls.createRequired = true;
          if (t.upper === 'DELETE' && (isWord(toks[k + 1], 'REQUIRED') || isWord(toks[k + 2], 'REQUIRED'))) cls.deleteRequired = true;
        }
      }
      doc.classes.push(cls);
      (doc as ParsedDoc & { _openClass?: ClassDef; _openFn?: FnDef })._openClass = cls;
      (doc as ParsedDoc & { _openFn?: FnDef })._openFn = undefined;
      return;
    }
    case 'LIKE': {
      const cls = currentClass(doc, L);
      for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.String) { t.role = 'className'; cls?.likes.push(t.text.slice(1, -1)); }
      }
      return;
    }
    case 'PROPERTY': {
      const cls = currentClass(doc, L);
      let k = from;
      let mode = '';
      let member: ClassMember | undefined;
      // PROPERTY a, b$=expr SET L: a name starts each item; words of an =expr are ordinary references
      let expectName = true, depth = 0;
      for (; k < toks.length; k++) {
        const t = toks[k];
        if (isPunct(t, '(') || isPunct(t, '[')) depth++;
        else if (isPunct(t, ')') || isPunct(t, ']')) depth--;
        else if (depth === 0 && isPunct(t, ',')) expectName = true;
        if (t.kind !== T.Word) continue;
        if (!expectName && depth > 0) continue;
        if (!expectName && !/^(GET|SET|READONLY|LOCAL|ERR)$/.test(t.upper) && !(mode === 'GET' || mode === 'SET')) continue;
        if (t.upper === 'GET' || t.upper === 'SET' || t.upper === 'READONLY' || t.upper === 'LOCAL') { t.role = 'clause'; mode = t.upper; continue; }
        if ((mode === 'GET' || mode === 'SET') && member) {
          if (t.upper === 'ERR') { t.role = 'clause'; } else {
            addRef(doc, st, t, 'PROPERTY ' + mode);
            if (mode === 'GET') member.getLabel = t.text; else member.setLabel = t.text;
          }
          mode = '';
          continue;
        }
        t.role = 'property';
        expectName = false;
        member = { name: t.text, span: span(L, t), kind: 'property', local: false, signature: t.text };
        cls?.members.push(member);
        addVar(doc, L, t, true);
      }
      return;
    }
    case 'FUNCTION': {
      // FUNCTION [LOCAL] [PERFORM] name(params)label | FUNCTION name(params) ERR  (also: ... FOR CLASS)
      const cls = currentClass(doc, L);
      let k = from;
      let local = false, perform = false;
      while (isWord(toks[k], 'LOCAL') || isWord(toks[k], 'PERFORM')) {
        if (toks[k].upper === 'LOCAL') local = true; else perform = true;
        toks[k].role = 'clause'; k++;
      }
      const nameTok = toks[k];
      if (!nameTok || nameTok.kind !== T.Word) return;
      nameTok.role = 'method';
      k++;
      const params: string[] = [];
      let sigEnd = k;
      if (isPunct(toks[k], '(')) {
        let d = 0;
        for (; k < toks.length; k++) {
          const t = toks[k];
          if (isPunct(t, '(')) d++;
          else if (isPunct(t, ')')) { d--; if (d === 0) { k++; break; } }
          else if (t.kind === T.Word && d === 1) { t.role = 'parameter'; params.push(t.text); }
        }
        sigEnd = k;
      }
      let label: string | undefined;
      if (isOp(toks[k], '=')) {
        // FUNCTION name(params)=expression
        classifyExpr(doc, st, toks, k + 1);
        k = toks.length;
      }
      for (; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word) {
          if (t.upper === 'ERR' || t.upper === 'FOR' || t.upper === 'CLASS') { t.role = 'clause'; continue; }
          if (!label) { label = t.text; addRef(doc, st, t, 'FUNCTION'); }
        }
      }
      const sig = nameTok.text + '(' + params.join(',') + ')';
      void sigEnd;
      cls?.members.push({ name: nameTok.text, span: span(L, nameTok), kind: 'function', params, label, local, perform, signature: sig });
      return;
    }
    case 'DEF': {
      // DEF FNname(params)=expr   or multi-line DEF FNname(params) ... END DEF
      const nameTok = toks[from];
      if (nameTok && nameTok.kind === T.Word && /^FN/i.test(nameTok.text)) {
        nameTok.role = 'userFunction';
        const params: string[] = [];
        let k = from + 1;
        if (isPunct(toks[k], '(')) {
          let d = 0;
          for (; k < toks.length; k++) {
            const t = toks[k];
            if (isPunct(t, '(')) d++;
            else if (isPunct(t, ')')) { d--; if (d === 0) { k++; break; } }
            else if (t.kind === T.Word && d === 1) { t.role = 'parameter'; params.push(t.text); addVar(doc, L, t, true, true); }
          }
        }
        const single = isOp(toks[k], '=');
        const fn: FnDef = { name: nameTok.text, span: span(L, nameTok), params, endLine: single ? L : -1, returns: /\$$/.test(nameTok.text) ? 'string' : 'number' };
        doc.fns.set(nameTok.upper, fn);
        if (!single) (doc as ParsedDoc & { _openFn?: FnDef })._openFn = fn;
        classifyExpr(doc, st, toks, k + (single ? 1 : 0));
        return;
      }
      classifyExpr(doc, st, toks, from);
      return;
    }
    case 'ON': {
      // ON expr GOTO a,b,c  /  ON expr GOSUB ...
      let k = from;
      for (; k < toks.length; k++) {
        if (isWord(toks[k], 'GOTO') || isWord(toks[k], 'GOSUB')) break;
      }
      classifyExpr(doc, st, toks.slice(0, k), from);
      if (k < toks.length) {
        toks[k].role = 'clause';
        for (let j = k + 1; j < toks.length; j++) {
          const t = toks[j];
          if (t.kind === T.Word || t.kind === T.Number) addRef(doc, st, t, 'ON ' + toks[k].upper);
        }
      }
      return;
    }
    case 'IF': {
      // IF cond THEN stmt|lineno [ELSE stmt|lineno]  -- THEN/ELSE introduce nested statements
      classifyIf(doc, st, toks, from);
      return;
    }
    case 'CALL': case 'PERFORM': case 'RUN': case 'LOAD': case 'MERGE': case 'EXECUTE': case 'PROCESS': {
      const t = toks[from];
      if (t && t.kind === T.String && kind !== 'EXECUTE') {
        const s = t.text.slice(1, -1).replace(/""/g, '"');
        const [prog, entry] = s.split(';');
        if (prog) doc.links.push({ target: prog, entry, span: span(L, t), directive: kind });
      }
      classifyExpr(doc, st, toks, from);
      return;
    }
    case 'ENTER': {
      for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word && !isOption(toks, k)) { setVarRole(t); addVar(doc, L, t, true, true); }
        else if (t.kind === T.Word) classifyExpr(doc, st, toks, k);
      }
      return;
    }
    case 'LOCAL': {
      // LOCAL var[=init],...  (class level declares a private property)
      const cls = currentClass(doc, L);
      const inClassHeader = !!cls;
      let k = from;
      while (k < toks.length) {
        const t = toks[k];
        if (t.kind === T.Word && (k === from || isPunct(toks[k - 1], ','))) {
          setVarRole(t);
          addVar(doc, L, t, true);
          if (inClassHeader && cls) cls.members.push({ name: t.text, span: span(L, t), kind: 'property', local: true, signature: t.text });
          k++;
          continue;
        }
        if (isOp(t, '=')) {
          let e = k + 1;
          let d = 0;
          for (; e < toks.length; e++) {
            if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) d++;
            else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) d--;
            else if (isPunct(toks[e], ',') && d === 0) break;
          }
          classifyExpr(doc, st, toks.slice(0, e), k + 1);
          k = e;
          continue;
        }
        if (isPunct(t, '[')) {
          let e = k + 1, d = 1;
          for (; e < toks.length && d > 0; e++) { if (isPunct(toks[e], '[')) d++; else if (isPunct(toks[e], ']')) d--; }
          classifyExpr(doc, st, toks.slice(0, e), k + 1);
          k = e;
          continue;
        }
        k++;
      }
      return;
    }
    case 'FOR': {
      const v = toks[from];
      if (v && v.kind === T.Word) { setVarRole(v); addVar(doc, L, v, true); }
      classifyExpr(doc, st, toks, from + 1);
      return;
    }
    case 'IOLIST': {
      // every name in an IOLIST is a variable, even ones spelled like directives (NEXT, PREV ...)
      for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word && !(isWord(t, 'IOL') && isOp(toks[k + 1], '='))) { setVarRole(t); addVar(doc, L, t, true); }
      }
      classifyExpr(doc, st, toks, from);
      return;
    }
    case 'NEXT': {
      for (let k = from; k < toks.length; k++) if (toks[k].kind === T.Word) { setVarRole(toks[k]); addVar(doc, L, toks[k], false); }
      return;
    }
    case 'LET': {
      classifyAssignment(doc, st, toks, toks[0] === st.head && toks[0].role !== 'directive' ? 0 : from);
      return;
    }
    case 'DIM': case 'REDIM': {
      for (let k = from; k < toks.length; k++) {
        const t = toks[k];
        if (t.kind === T.Word && (k === from || isPunct(toks[k - 1], ',')) && !FUNCTIONS.has(t.upper)) {
          if (isWord(t, 'IOL') || isWord(t, 'CLASS')) { t.role = 'clause'; continue; }
          setVarRole(t); addVar(doc, L, t, true);
        } else if (t.kind === T.Word && !t.role) {
          classifyExpr(doc, st, [t], 0);
        } else if (t.kind !== T.Word) {
          // punctuation / literals
        }
      }
      // classify expressions inside brackets
      classifyExpr(doc, st, toks, from, true);
      return;
    }
    case 'READ': case 'INPUT': case 'EXTRACT': case 'FIND': case 'OBTAIN': case 'ACCEPT': {
      classifyIO(doc, st, toks, from, true);
      return;
    }
    case 'WRITE': case 'PRINT': case 'UPDATE': case 'INSERT': case 'REMOVE': case 'OPEN': case 'CLOSE': case 'LOCK': case 'UNLOCK':
    case 'PURGE': case 'ERASE': case 'SERIAL': case 'KEYED': case 'DIRECT': case 'SORT': case 'INDEXED': case 'DIRECTORY': case 'PROGRAM': case 'RENAME': case 'FILE': case 'SELECT': case 'TRANSLATE': case 'REFILE': {
      classifyIO(doc, st, toks, from, false);
      return;
    }
    case 'END DEF': {
      const d = doc as ParsedDoc & { _openClass?: ClassDef; _openFn?: FnDef };
      if (d._openFn) d._openFn = undefined; else d._openClass = undefined;
      return;
    }
    case 'END SWITCH': case 'END_IF': case 'END_TRY': case 'NEXT RECORD': return;
    default:
      classifyExpr(doc, st, toks, from);
  }
}

function setVarRole(t: Token) {
  if (t.role) return;
  if (t.text.startsWith('%')) t.role = 'globalVariable';
  else if (t.text.endsWith('$')) t.role = 'stringVariable';
  else if (t.text.endsWith('%')) t.role = 'integerVariable';
  else t.role = 'variable';
}

function isOption(toks: Token[], k: number): boolean {
  const t = toks[k];
  return t.kind === T.Word && FILE_OPTIONS.has(t.upper) && isOp(toks[k + 1], '=') && isPunct(toks[k - 1], ',');
}

function currentClass(doc: ParsedDoc, _line: number): ClassDef | undefined {
  return (doc as ParsedDoc & { _openClass?: ClassDef })._openClass;
}
const classOpen = new WeakMap<ClassDef, boolean>();

function classifyIf(doc: ParsedDoc, st: Stmt, toks: Token[], from: number) {
  let k = from;
  let d = 0;
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (isPunct(t, '(') || isPunct(t, '[')) d++;
    else if (isPunct(t, ')') || isPunct(t, ']')) d--;
    else if (d === 0 && isWord(t, 'THEN')) break;
  }
  classifyExpr(doc, st, toks.slice(0, k), from);
  if (k >= toks.length) return;
  toks[k].role = 'clause';
  // the THEN part runs up to ELSE (at depth 0, not inside a nested IF without ELSE handling)
  let e = k + 1;
  let nestedIf = 0;
  d = 0;
  for (; e < toks.length; e++) {
    const t = toks[e];
    if (isPunct(t, '(') || isPunct(t, '[')) d++;
    else if (isPunct(t, ')') || isPunct(t, ']')) d--;
    else if (d === 0 && isWord(t, 'IF')) nestedIf++;
    else if (d === 0 && isWord(t, 'ELSE')) { if (nestedIf === 0) break; nestedIf--; }
  }
  classifySubStatement(doc, st, toks.slice(k + 1, e));
  if (e < toks.length) {
    toks[e].role = 'clause';
    classifySubStatement(doc, st, toks.slice(e + 1));
  }
}

function classifySubStatement(doc: ParsedDoc, parent: Stmt, all: Token[]) {
  let d = 0;
  let part: Token[] = [];
  const parts: Token[][] = [];
  for (const t of all) {
    if (isPunct(t, '(') || isPunct(t, '[')) d++;
    else if (isPunct(t, ')') || isPunct(t, ']')) d--;
    if (d === 0 && isPunct(t, ';') && !(part.length && isWord(part[0], 'IF'))) { parts.push(part); part = []; continue; }
    part.push(t);
  }
  parts.push(part);
  for (const p of parts) classifyOneSub(doc, parent, p);
}

function classifyOneSub(doc: ParsedDoc, parent: Stmt, toks: Token[]) {
  if (!toks.length) return;
  if (toks.length === 1 && toks[0].kind === T.Number) { addRef(doc, parent, toks[0], 'THEN'); return; }
  const sub: Stmt = { line: parent.line, tokens: toks, kind: '', depth: parent.depth };
  classifyStatement(doc, sub);
  (parent as Stmt & { subs?: Stmt[] }).subs = [...((parent as Stmt & { subs?: Stmt[] }).subs ?? []), sub];
}

function classifyAssignment(doc: ParsedDoc, st: Stmt, toks: Token[], from: number) {
  // target(s): var[subs] = expr   (multiple assignments allowed:  LET A=1,B$="x")
  let k = from;
  let expectTarget = true;
  let d = 0;
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (expectTarget && t.kind === T.Word) {
      const next = toks[k + 1];
      if (next && next.kind === T.Member) {
        // obj'prop = value
        classifyExpr(doc, st, toks, k, false, true);
        return;
      }
      setVarRole(t); addVar(doc, st.line, t, true);
      expectTarget = false;
      continue;
    }
    if (isPunct(t, '(') || isPunct(t, '[')) {
      d++;
      if (!expectTarget) {
        // subscripts / substring of the target
        let e = k + 1, dd = 1;
        for (; e < toks.length && dd > 0; e++) { if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) dd++; else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) dd--; }
        classifyExpr(doc, st, toks.slice(0, e - 1), k + 1);
        k = e - 1; d--;
      }
      continue;
    }
    if (isPunct(t, ')') || isPunct(t, ']')) { d--; continue; }
    if (t.kind === T.Operator && /^(=|\+=|-=|\*=|\/=|\^=)$/.test(t.text) && d === 0) {
      // expression up to next top-level comma
      let e = k + 1, dd = 0;
      for (; e < toks.length; e++) {
        if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) dd++;
        else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) dd--;
        else if (isPunct(toks[e], ',') && dd === 0) break;
      }
      classifyExpr(doc, st, toks.slice(0, e), k + 1);
      k = e;
      expectTarget = true;
      continue;
    }
    if (t.kind === T.Operator && (t.text === '++' || t.text === '--')) continue;
  }
}

function classifyIO(doc: ParsedDoc, st: Stmt, toks: Token[], from: number, assigns: boolean) {
  // (chan, options...) list
  let k = from;
  if (isPunct(toks[k], '(')) {
    let d = 0;
    let e = k;
    for (; e < toks.length; e++) {
      if (isPunct(toks[e], '(') || isPunct(toks[e], '[')) d++;
      else if (isPunct(toks[e], ')') || isPunct(toks[e], ']')) { d--; if (d === 0) break; }
    }
    classifyExpr(doc, st, toks.slice(0, e + 1), k + 1);
    k = e + 1;
  }
  if (st.kind === 'SELECT') {
    // SELECT list FROM chan|"file" [,KNO=..] BEGIN key END key WHERE cond
    for (let j = k; j < toks.length; j++) if (isWord(toks[j]) && /^(FROM|BEGIN|END|WHERE|IOL|RECORD)$/.test(toks[j].upper)) toks[j].role = 'clause';
    classifyExpr(doc, st, toks, k);
    return;
  }
  if (assigns) {
    // READ (..) var, var$, IOL=...  -- variables become defined
    let d = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (isPunct(t, '(') || isPunct(t, '[')) d++;
      else if (isPunct(t, ')') || isPunct(t, ']')) d--;
      if (t.kind === T.Word && d === 0 && !t.role && !isOption(toks, j) && !(isOp(toks[j + 1], '=')) && !isWord(t, 'RECORD') && !isWord(t, 'DATA') && !isWord(t, 'FROM') && !isWord(t, 'TO') && !isWord(t, 'IOL')) {
        if (FUNCTIONS.has(t.upper) && isPunct(toks[j + 1], '(')) continue;
        if (SYSVARS.has(t.upper)) continue;
        setVarRole(t); addVar(doc, st.line, t, true);
      }
    }
  }
  classifyExpr(doc, st, toks, k);
}

/** Generic expression/argument classification. */
function classifyExpr(doc: ParsedDoc, st: Stmt, toks: Token[], from: number, skipDefs = false, firstIsObj = false) {
  void skipDefs;
  const L = st.line;
  for (let k = from; k < toks.length; k++) {
    const t = toks[k];
    if (t.role) continue;
    if (t.kind === T.Member) {
      t.role = isPunct(toks[k + 1], '(') ? 'method' : 'property';
      continue;
    }
    if (t.kind !== T.Word) continue;
    const next = toks[k + 1];
    const prev = toks[k - 1];
    // file options:  ,ERR=label  (KEY=expr ...)
    if (isOption(toks, k)) {
      t.role = 'fileOption';
      if (BRANCH_TARGET_OPTIONS.has(t.upper)) {
        const v = toks[k + 2];
        if (v && (v.kind === T.Word || v.kind === T.Number) && !isPunct(toks[k + 3], '(')) {
          if (v.kind === T.Number || !/[$%]$/.test(v.text)) { addRef(doc, st, v, t.upper + '='); k += 2; }
        }
      }
      continue;
    }
    if (BRANCH_OPTIONS.has(t.upper) && isOp(next, '=') && isPunct(prev, ',')) { t.role = 'fileOption'; continue; }
    // GOTO / GOSUB inside sub-statements handled by classifyStatement; here only words
    if (next && next.kind === T.Member && !firstIsObj) {
      t.role = 'objectVariable'; addVar(doc, L, t, false);
      continue;
    }
    if (firstIsObj && k === from) { t.role = 'objectVariable'; addVar(doc, L, t, false); continue; }
    if (isPunct(next, '(')) {
      // AND (x) / OR (x) are logical operators; AND(a,b) touching its parenthesis is the bitwise function
      if ((t.upper === 'AND' || t.upper === 'OR') && next!.start > t.end) { t.role = 'clause'; continue; }
      if (FUNCTIONS.has(t.upper) && !/[$%]$/.test(t.text)) { t.role = 'function'; continue; }
      if (/^FN/i.test(t.text) && doc.fns.has(t.upper)) { t.role = 'userFunction'; continue; }
      if (/^FN/i.test(t.text) && !/[.]/.test(t.text)) { t.role = 'userFunction'; continue; }
      setVarRole(t); addVar(doc, L, t, false);
      continue;
    }
    if (/^FN/i.test(t.text) && doc.fns.has(t.upper)) { t.role = 'userFunction'; continue; }
    if (SYSVARS.has(t.upper)) { t.role = 'sysvar'; continue; }
    if (t.upper === '_OBJ' || t.upper === '_PARENT') { t.role = 'sysvar'; continue; }
    if (CLAUSE_WORDS.has(t.upper) || DIRECTIVES.has(t.upper)) {
      // ProvideX allows variables spelled like directives (SORT[0], IF ROUND=0, NOT(PROCEED)):
      // a keyword-like word in operand position is a variable
      const operandPos = (prev && (prev.kind === T.Operator || isPunct(prev, '('))) || isPunct(next, '[') || isPunct(next, ')') ||
        (next && next.kind === T.Operator && /^(=|<>|<|>|<=|>=|=<|=>|\+=|-=|\*=|\/=)$/.test(next.text));
      if (!operandPos) { t.role = 'clause'; continue; }
    }
    if (FUNCTIONS.has(t.upper) && !/[$%]$/.test(t.text) && functionDoc(t.upper)?.signatures?.some((s) => (s.minArgs ?? 1) === 0)) { t.role = 'function'; continue; }
    setVarRole(t);
    addVar(doc, L, t, false);
  }
}

// ---------------- structure analysis ----------------
interface Open { kind: string; line: number; token?: Token; cls?: ClassDef; fn?: FnDef }

const CLOSERS: Record<string, string[]> = {
  NEXT: ['FOR'],
  WEND: ['WHILE'],
  UNTIL: ['REPEAT'],
  'END SWITCH': ['SWITCH'],
  'END_TRY': ['TRY'],
  'NEXT RECORD': ['SELECT'],
  'END DEF': ['DEF CLASS', 'DEF FN'],
};

function analyzeStructure(doc: ParsedDoc) {
  const stack: Open[] = [];
  const braceStack: { line: number; tok: Token }[] = [];
  const push = (o: Open) => stack.push(o);
  const report = (line: number, t: Token | undefined, message: string, severity: Problem['severity'] = 'warning', code = 'block-structure') => {
    doc.problems.push({ span: t ? span(line, t) : { line, start: 0, end: doc.lines[line]?.length ?? 0 }, message, severity, code });
  };

  const visit = (st: Stmt) => {
    const head = st.head ?? st.tokens[0];
    switch (st.kind) {
      case 'BLOCK_OPEN': break;
      case 'FOR': {
        // single line FOR ... ; NEXT  is handled naturally since statements are visited in order
        push({ kind: 'FOR', line: st.line, token: head });
        break;
      }
      case 'WHILE': push({ kind: 'WHILE', line: st.line, token: head }); break;
      case 'REPEAT': push({ kind: 'REPEAT', line: st.line, token: head }); break;
      case 'SWITCH': push({ kind: 'SWITCH', line: st.line, token: head }); break;
      case 'TRY': push({ kind: 'TRY', line: st.line, token: head }); break;
      case 'SELECT': push({ kind: 'SELECT', line: st.line, token: head }); break;
      case 'DEF CLASS': {
        const cls = doc.classes[doc.classes.length - 1];
        classOpen.set(cls, true);
        push({ kind: 'DEF CLASS', line: st.line, token: head, cls });
        break;
      }
      case 'DEF': {
        const fnTok = st.tokens[1];
        if (fnTok) {
          const fn = doc.fns.get(fnTok.upper);
          if (fn && fn.endLine === -1) {
            // a new multi-line function implicitly ends the previous one (END DEF is optional)
            const top = stack[stack.length - 1];
            if (top && top.kind === 'DEF FN') { stack.pop(); if (top.fn) top.fn.endLine = st.line - 1; }
            push({ kind: 'DEF FN', line: st.line, token: head, fn });
          }
        }
        break;
      }
      case 'CASE': case 'DEFAULT': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'SWITCH') report(st.line, head, `${st.kind} outside of SWITCH`);
        break;
      }
      case 'CATCH': case 'FINALLY': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'TRY') report(st.line, head, `${st.kind} without TRY`);
        break;
      }
      case 'PROPERTY': case 'LIKE': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'DEF CLASS') report(st.line, head, `${st.kind} is only valid inside a DEF CLASS ... END DEF block`);
        break;
      }
      case 'FUNCTION': {
        const top = stack[stack.length - 1];
        if (!top || top.kind !== 'DEF CLASS') report(st.line, head, 'FUNCTION is only valid inside a DEF CLASS ... END DEF block');
        break;
      }
      default: {
        const closes = CLOSERS[st.kind];
        if (!closes) break;
        // find the nearest matching opener; tolerate jumping out of loops (BREAK/EXITTO style code)
        let idx = -1;
        for (let j = stack.length - 1; j >= 0; j--) if (closes.includes(stack[j].kind)) { idx = j; break; }
        if (idx < 0) {
          // NEXT without FOR is common in programs that GOTO into loops; keep it a warning
          report(st.line, head, `${st.kind} without matching ${closes.join(' / ')}`);
          break;
        }
        for (let j = stack.length - 1; j > idx; j--) {
          const o = stack[j];
          // inner unclosed constructs are allowed for SELECT/FOR jumped out of by BREAK; only report unbalanced classes
          if (o.kind === 'DEF CLASS') report(o.line, o.token, `${o.kind} is not closed before ${st.kind}`);
        }
        const o = stack[idx];
        stack.length = idx;
        if (st.line > o.line) doc.blocks.push({ kind: o.kind, startLine: o.line, endLine: st.line });
        if (o.cls) { o.cls.endLine = st.line; classOpen.set(o.cls, false); }
        if (o.fn) o.fn.endLine = st.line;
      }
    }
  };

  for (let i = 0; i < doc.stmtsByLine.length; i++) {
    for (const st of doc.stmtsByLine[i]) {
      if (st.kind === 'BLOCK_OPEN') braceStack.push({ line: st.line, tok: st.tokens[st.tokens.length - 1] });
      else if (st.kind === 'BLOCK_CLOSE') {
        const o = braceStack.pop();
        if (!o) report(st.line, st.tokens[0], 'Unmatched "}"', 'error', 'brace');
        else if (st.line > o.line) doc.blocks.push({ kind: '{', startLine: o.line, endLine: st.line });
      } else {
        // a '{' at the end of a statement (IF x THEN {) is split off by the lexer pass into BLOCK_OPEN
        const last = st.tokens[st.tokens.length - 1];
        if (last && isPunct(last, '{')) braceStack.push({ line: st.line, tok: last });
      }
      visit(st);
      for (const sub of (st as Stmt & { subs?: Stmt[] }).subs ?? []) visit(sub);
    }
  }
  for (const o of braceStack) report(o.line, o.tok, 'Unclosed "{" block', 'error', 'brace');
  for (const o of stack) {
    if (o.kind === 'DEF CLASS') { report(o.line, o.token, 'DEF CLASS without END DEF', 'error'); if (o.cls) { o.cls.endLine = doc.lines.length - 1; } }
    else if (o.kind === 'DEF FN') { if (o.fn) o.fn.endLine = doc.lines.length - 1; }
    else if (o.kind === 'WHILE' || o.kind === 'REPEAT' || o.kind === 'SWITCH' || o.kind === 'TRY') report(o.line, o.token, `${o.kind} block is never closed`);
  }
  // section folding: from each label to the line before the next label / class
  const labelLines = [...doc.labels.values()].flat().map((l) => l.span.line).sort((a, b) => a - b);
  for (let j = 0; j < labelLines.length; j++) {
    const start = labelLines[j];
    let end = (j + 1 < labelLines.length ? labelLines[j + 1] : doc.lines.length) - 1;
    while (end > start && doc.lines[end].trim().replace(/^\d+\s*$/, '') === '') end--;
    if (end > start) doc.blocks.push({ kind: 'label', startLine: start, endLine: end });
  }
}

/** Finds the token at a position. */
export function tokenAt(doc: ParsedDoc, line: number, col: number): Token | undefined {
  const lx = doc.lexed[line];
  if (!lx) return undefined;
  for (const t of lx.tokens) if (col >= t.start && col <= t.end && t.kind !== T.Comment) return t;
  return undefined;
}

export function statementAt(doc: ParsedDoc, line: number, col: number): Stmt | undefined {
  const sts = doc.stmtsByLine[line] ?? [];
  let best: Stmt | undefined;
  for (const s of sts) {
    const a = s.tokens[0]?.start ?? 0;
    if (a <= col) best = s;
  }
  return best;
}
