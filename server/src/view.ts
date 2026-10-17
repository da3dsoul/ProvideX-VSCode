// Readable view of ProvideX programs.
//
// ProvideX stores statement numbers, strips all whitespace/indentation and re-inserts the implied LET
// (verified against ProvideX 9.62). The readable view therefore:
//   * hides statement numbers; numbers that are referenced (GOTO 0100, ERR=0100, IF x THEN 0100 ...)
//     become labels (an existing label on the target statement is reused, else L0100:)
//   * puts one statement per line and expands single-line  IF c THEN a; b ELSE d  into { } blocks
//     (ProvideX treats everything after THEN up to ELSE as conditional, so this is exact)
//   * indents blocks and adds spacing
// and maps back on save: unchanged statements keep their original numbers (LCS diff against the view
// that was opened), new statements get numbers in the gaps, and only if a gap is too small is the
// program renumbered (safe, because every reference is a label by then).
import { lexLine, T, Token } from './lexer';
import { parse, ParsedDoc } from './parser';
import { nextStatementNumber } from './analyzer';
import { formatDocument, respaceLine } from './formatter';
export { respaceLine };

export interface ViewOptions {
  splitStatements: boolean;
  expandIf: boolean;
  indent: boolean;
  indentSize: number;
  spacing: boolean;
  keywordCase: 'upper' | 'lower' | 'preserve';
}

export const defaultViewOptions: ViewOptions = { splitStatements: true, expandIf: true, indent: true, indentSize: 2, spacing: true, keywordCase: 'upper' };

export interface ViewResult {
  text: string;
  /** statement number of the first view line of each statement (null for the other lines of a statement) */
  map: (number | null)[];
  /** statement number each view line was produced from (all lines of a split/expanded statement share it) */
  origin: (number | null)[];
  /** single-line form of each statement, with references already turned into labels */
  joined: Record<number, string>;
}

const MAX_STMT = 65000;

interface OutLine { text: string; n: number | null; origin: number | null }

/** Numbered ProvideX listing (LIST output) -> readable view. */
export function toView(numbered: string[], opts: ViewOptions = defaultViewOptions): ViewResult {
  const doc = parse(numbered.join('\n'));
  // ---- statement numbers that are jumped to -> label names
  const labelFor = new Map<number, string>();
  const used = new Set([...doc.labels.keys()]);
  const target = (n: number): number | undefined => (doc.lineNumbers.has(n) ? n : nextStatementNumber(doc, n));
  for (const r of doc.refs) {
    if (r.kind !== 'line') continue;
    const t = target(parseInt(r.target, 10));
    if (t === undefined || labelFor.has(t)) continue;
    const line = doc.lineNumbers.get(t)!;
    const first = doc.lexed[line].tokens.find((x) => x.kind !== T.LineNumber);
    if (first && first.kind === T.Label) { labelFor.set(t, first.text); continue; }
    let name = 'L' + String(t).padStart(4, '0');
    while (used.has(name.toUpperCase())) name += '_';
    used.add(name.toUpperCase());
    labelFor.set(t, name);
  }

  const out: OutLine[] = [];
  const joined: Record<number, string> = {};
  for (let i = 0; i < doc.lines.length; i++) {
    const lx = doc.lexed[i];
    const src = doc.lines[i];
    if (!lx.lineNumber) { if (src.trim()) out.push({ text: src.trim(), n: null, origin: null }); continue; }
    const n = parseInt(lx.lineNumber.text, 10);
    const lbl = labelFor.get(n);
    const firstTok = lx.tokens.find((x) => x.kind !== T.LineNumber);
    let first = true;
    const emit = (text: string) => { out.push({ text, n: first ? n : null, origin: n }); first = false; };
    const synthetic = !!lbl && !(firstTok && firstTok.kind === T.Label);
    if (synthetic) emit(lbl + ':');

    // replace numeric references on this line by label names (right to left keeps offsets valid)
    let code = src;
    const refs = doc.refs.filter((r) => r.line === i && r.kind === 'line').sort((a, b) => b.token.start - a.token.start);
    for (const r of refs) {
      const t = target(parseInt(r.target, 10));
      const name = t !== undefined ? labelFor.get(t) : undefined;
      if (!name) continue;
      code = code.slice(0, r.token.start) + (r.context === 'THEN' ? 'GOTO ' + name : name) + code.slice(r.token.end);
    }
    // drop the statement number (and LIST's '?' syntax-error marker stays visible as a comment)
    const bad = src[lx.codeStart - 1] === '?';
    code = code.slice(lx.codeStart).replace(/^ /, '');
    joined[n] = (synthetic ? lbl + ': ' : '') + (code.trim() ? code.trimEnd() : 'REM');
    if (!code.trim()) { if (first) emit('!'); continue; }
    for (const l of restructure(code, opts)) emit(l);
    if (bad) out[out.length - 1].text += ' ! <- ProvideX reported a syntax error in this statement';
  }

  let text = out.map((o) => o.text).join('\n');
  text = prettify(text, opts);
  return { text, map: out.map((o) => o.n), origin: out.map((o) => o.origin), joined };
}

/** Splits a (number-less) source line into one statement per line and expands single-line IFs. */
export function restructure(code: string, opts: ViewOptions): string[] {
  if (!opts.splitStatements && !opts.expandIf) return [code];
  const lx = lexLine(code);
  const toks = lx.tokens;
  // split on ';' at depth 0, except that IF consumes the rest of its line
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  let endIfSplit = false;
  for (const t of toks) {
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) depth++;
    if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) depth--;
    // IF (and an ELSE after a block) makes the rest of the line conditional: never split it
    const inIf = cur.some((x) => x.kind === T.Word && (x.upper === 'IF' || x.upper === 'ELSE'));
    // IF c THEN a END_IF ; b  ->  IF c THEN a / b.  END_IF closes the innermost IF (verified), so only an
    // END_IF that closes the outermost IF of the statement ends its conditional part.
    if (depth === 0 && t.kind === T.Word && (t.upper === 'END_IF' || t.upper === 'FI') && inIf && opts.splitStatements) {
      const ifs = cur.filter((x) => x.kind === T.Word && x.upper === 'IF').length - cur.filter((x) => x.kind === T.Word && (x.upper === 'END_IF' || x.upper === 'FI')).length;
      if (ifs <= 1) { parts.push(cur); cur = []; endIfSplit = true; continue; }
    }
    if (endIfSplit && t.kind === T.Punct && t.text === ';' && cur.length === 0) { endIfSplit = false; continue; }
    endIfSplit = false;
    if (depth === 0 && t.kind === T.Punct && t.text === ';' && !inIf && opts.splitStatements) { parts.push(cur); cur = []; continue; }
    // a label at the start of a line goes on its own line
    if (t.kind === T.Label && opts.splitStatements) { if (cur.length) parts.push(cur); parts.push([t]); cur = []; continue; }
    if (t.kind === T.Punct && t.text === ':' && cur.length === 0 && parts.length && parts[parts.length - 1][0]?.kind === T.Label) { parts[parts.length - 1].push(t); continue; }
    if (opts.splitStatements && depth === 0 && t.kind === T.Punct && !t.subscript && t.kind === T.Punct) {
      // one-line blocks  IF c THEN { a; b }  ->  IF c THEN { / a / b / }   ("} ELSE {" stays together)
      if (t.text === '{') { cur.push(t); parts.push(cur); cur = []; continue; }
      if (t.text === '}') { if (cur.length) parts.push(cur); cur = [t]; continue; }
    }
    if (cur.length === 1 && cur[0].kind === T.Punct && cur[0].text === '}' && !cur[0].subscript && !(t.kind === T.Word && t.upper === 'ELSE') && t.kind !== T.Comment) { parts.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  const out: string[] = [];
  for (const p of parts) {
    if (!p.length) continue;
    const text = code.slice(p[0].start, p[p.length - 1].end);
    if (opts.expandIf && p[0].kind === T.Word && p[0].upper === 'IF') out.push(...expandIf(text, opts));
    else out.push(text);
  }
  return out.length ? out : [code];
}

/** IF c THEN a; b ELSE d; e   ->   IF c THEN { / a / b / } ELSE { / d / e / }  (only when it helps readability). */
function expandIf(text: string, opts: ViewOptions): string[] {
  const toks = lexLine(text).tokens;
  const comment = toks.length && toks[toks.length - 1].kind === T.Comment ? toks[toks.length - 1] : undefined;
  const body = comment ? toks.slice(0, -1) : toks;
  // leave anything with real braces or END_IF alone
  if (body.some((t) => t.kind === T.Punct && (t.text === '{' || t.text === '}') && !t.subscript)) return [text];
  if (body.some((t) => t.kind === T.Word && (t.upper === 'END_IF' || t.upper === 'FI'))) return [text];
  let d = 0, thenIdx = -1;
  for (let k = 0; k < body.length; k++) {
    const t = body[k];
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    else if (d === 0 && t.kind === T.Word && t.upper === 'THEN') { thenIdx = k; break; }
  }
  if (thenIdx < 0 || thenIdx === body.length - 1) return [text];
  // ELSE belonging to this IF: skip ELSEs of nested IFs
  let elseIdx = -1, nested = 0;
  d = 0;
  for (let k = thenIdx + 1; k < body.length; k++) {
    const t = body[k];
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) d++;
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) d--;
    else if (d === 0 && t.kind === T.Word && t.upper === 'IF') nested++;
    else if (d === 0 && t.kind === T.Word && t.upper === 'ELSE') { if (nested === 0) { elseIdx = k; break; } nested--; }
  }
  const slice = (a: number, b: number) => (a < b ? text.slice(body[a].start, body[b - 1].end) : '');
  const thenText = slice(thenIdx + 1, elseIdx < 0 ? body.length : elseIdx);
  const elseText = elseIdx < 0 ? '' : slice(elseIdx + 1, body.length);
  const countStmts = (s: string) => restructure(s, { ...opts, expandIf: false }).length;
  const worth = elseIdx >= 0 ? countStmts(thenText) > 1 || countStmts(elseText) > 1 || text.length > 100 : countStmts(thenText) > 1;
  if (!worth) return [text];
  const head = text.slice(0, body[thenIdx].end) + ' {' + (comment ? ' ' + comment.text : '');
  const res = [head, ...restructure(thenText, opts)];
  if (elseIdx >= 0) res.push('} ELSE {', ...restructure(elseText, opts));
  res.push('}');
  return res;
}

/** Keyword case, spacing and indentation of a lineless view. */
export function prettify(text: string, opts: ViewOptions): string {
  let lines = text.split('\n');
  if (opts.spacing) lines = lines.map((l) => respaceLine(l));
  const doc = parse(lines.join('\n'));
  const edits = formatDocument(doc, { keywordCase: opts.keywordCase, indentBlocks: opts.indent, indentSize: opts.indentSize, useTabs: false });
  return applyEdits(lines, edits).join('\n');
}

function applyEdits(lines: string[], edits: ReturnType<typeof formatDocument>): string[] {
  const byLine = new Map<number, typeof edits>();
  for (const e of edits) { const a = byLine.get(e.range.start.line) ?? []; a.push(e); byLine.set(e.range.start.line, a); }
  return lines.map((l, i) => {
    const es = (byLine.get(i) ?? []).sort((a, b) => b.range.start.character - a.range.start.character);
    for (const e of es) l = l.slice(0, e.range.start.character) + e.newText + l.slice(e.range.end.character);
    return l;
  });
}

// ------------------------------------------------------------------ back to numbered source

export interface FromViewResult {
  /** numbered source lines ready for MERGE */
  numbered: string[];
  /** first view line of each numbered line (to map compiler diagnostics back) */
  viewLine: number[];
  /** the new base for the next save (statement numbers as written) */
  base: ViewResult;
  /** statements that could not keep their original number */
  renumbered: number;
}

interface Unit { text: string; cand?: number; view: number[]; fixed?: boolean }

const PLAIN_START = /^(?!\}|ELSE\b|CASE\b|DEFAULT\b|END\b|ENDDEF\b|END_|WEND\b|NEXT\b|UNTIL\b|CATCH\b|FINALLY\b|[A-Za-z_][A-Za-z0-9_.]*:)/i;

/**
 * Readable view -> numbered source.
 * Statements whose view lines are all unchanged are written back as their single-line form under their
 * original number; edited/new lines are numbered into the gaps. All jumps are labels in the view, so any
 * renumbering needed to make room is safe.
 */
export function fromView(viewText: string, base?: ViewResult): FromViewResult {
  const lines = viewText.split(/\r?\n/);
  const n = lines.length;
  const isCode = lines.map((l) => l.trim() !== '');
  const matchedFrom: (number | null)[] = new Array(n).fill(null); // base line index for unchanged lines
  if (base) {
    const a = base.text.split(/\r?\n/).map(normLine);
    const b = lines.map(normLine);
    for (const [i, j] of lcs(a, b)) matchedFrom[j] = i;
  }
  // which statements survived intact (all their lines unchanged and still contiguous, nothing inserted)
  const intact = new Map<number, { num: number; span: number[] }>(); // first view line -> statement
  if (base) {
    const baseLines = base.text.split(/\r?\n/);
    const linesOf = new Map<number, number[]>();
    base.origin.forEach((o, i) => { if (o != null && baseLines[i]?.trim()) { const a = linesOf.get(o) ?? []; a.push(i); linesOf.set(o, a); } });
    const newIndexOfBase = new Map<number, number>();
    matchedFrom.forEach((i, j) => { if (i != null) newIndexOfBase.set(i, j); });
    for (const [num, idxs] of linesOf) {
      if (!(num in base.joined)) continue;
      const js = idxs.map((i) => newIndexOfBase.get(i));
      if (js.some((j) => j === undefined)) continue;
      // the statement's lines must still be adjacent code lines (blank lines may be in between)
      let ok = true;
      for (let k = 1; k < js.length && ok; k++) for (let j = js[k - 1]! + 1; j < js[k]!; j++) if (isCode[j]) { ok = false; break; }
      if (ok) intact.set(js[0]!, { num, span: js as number[] });
    }
  }
  // build units
  const units: Unit[] = [];
  let pendingLabel: { text: string; view: number } | undefined;
  for (let j = 0; j < n; j++) {
    if (!isCode[j]) continue;
    const st = intact.get(j);
    if (st && base) {
      if (pendingLabel) { units.push({ text: pendingLabel.text, view: [pendingLabel.view] }); pendingLabel = undefined; }
      units.push({ text: base.joined[st.num], cand: st.num, view: st.span, fixed: true });
      j = st.span[st.span.length - 1];
      continue;
    }
    const text = lines[j].trim();
    let cand: number | undefined;
    const bi = matchedFrom[j];
    if (bi != null && base && base.map[bi] != null) cand = base.map[bi]!;
    // a label alone on a line is merged into the following plain statement
    if (/^[A-Za-z_][A-Za-z0-9_.]*:$/.test(text)) {
      if (pendingLabel) units.push({ text: pendingLabel.text, view: [pendingLabel.view] });
      pendingLabel = { text, view: j };
      continue;
    }
    if (pendingLabel) {
      if (PLAIN_START.test(text)) { units.push({ text: pendingLabel.text + ' ' + text, cand, view: [pendingLabel.view, j] }); pendingLabel = undefined; continue; }
      units.push({ text: pendingLabel.text, view: [pendingLabel.view] });
      pendingLabel = undefined;
    }
    units.push({ text, cand, view: [j] });
  }
  if (pendingLabel) units.push({ text: pendingLabel.text, view: [pendingLabel.view] });

  // number the units: keep increasing candidates, fill gaps, push later units forward when a gap is too small
  const nums: (number | undefined)[] = units.map((u) => u.cand);
  let last = 0;
  for (let u = 0; u < units.length; u++) {
    if (nums[u] !== undefined && (nums[u]! <= last || nums[u]! > MAX_STMT)) nums[u] = undefined;
    if (nums[u] !== undefined) last = nums[u]!;
  }
  let renumbered = 0;
  let prev = 0;
  for (let u = 0; u < units.length;) {
    if (nums[u] !== undefined) { prev = nums[u]!; u++; continue; }
    // run of unnumbered units [u, v)
    let v = u;
    while (v < units.length && nums[v] === undefined) v++;
    // extend the run over following numbered units until there is room
    while (v < units.length && nums[v]! - prev - 1 < v - u) { if (units[v].fixed) renumbered++; nums[v] = undefined; v++; while (v < units.length && nums[v] === undefined) v++; }
    const hi = v < units.length ? nums[v]! : MAX_STMT + 1;
    const count = v - u;
    if (hi - prev - 1 < count) throw new Error('Program too large to number (more than ' + MAX_STMT + ' statements)');
    const step = Math.max(1, Math.min(10, Math.floor((hi - prev - 1) / (count + (v < units.length ? 1 : 0)))));
    for (let k = u; k < v; k++) { prev += step; nums[k] = prev; }
    u = v;
  }

  const numbered: string[] = [];
  const viewLine: number[] = [];
  const nb: ViewResult = { text: viewText, map: new Array(n).fill(null), origin: new Array(n).fill(null), joined: {} };
  units.forEach((unit, u) => {
    const num = nums[u]!;
    numbered.push(String(num).padStart(4, '0') + ' ' + unit.text);
    viewLine.push(unit.view[0]);
    nb.map[unit.view[0]] = num;
    for (const j of unit.view) nb.origin[j] = num;
    nb.joined[num] = unit.text;
  });
  return { numbered, viewLine, base: nb, renumbered };
}

/** Canonical form of a line for change detection: tokens only (spacing, keyword case and LET do not matter). */
export function normLine(s: string): string {
  const toks = lexLine(s).tokens.filter((t) => t.kind !== T.LineNumber);
  const parts = toks.map((t) => (t.kind === T.String || t.kind === T.Comment ? t.text.trimEnd() : t.upper));
  if (parts[0] === 'LET') parts.shift();
  return parts.join(' ');
}

/** Longest common subsequence of two line arrays -> matched index pairs. */
export function lcs(a: string[], b: string[]): [number, number][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const pairs: [number, number][] = [];
  for (let i = 0; i < p; i++) pairs.push([i, i]);
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
  if (A.length && B.length && A.length * B.length <= 25_000_000) {
    const m = A.length, nn = B.length;
    const dp = new Uint32Array((m + 1) * (nn + 1));
    for (let i = m - 1; i >= 0; i--) for (let k = nn - 1; k >= 0; k--) {
      dp[i * (nn + 1) + k] = A[i] === B[k] ? dp[(i + 1) * (nn + 1) + k + 1] + 1 : Math.max(dp[(i + 1) * (nn + 1) + k], dp[i * (nn + 1) + k + 1]);
    }
    let i = 0, k = 0;
    while (i < m && k < nn) {
      if (A[i] === B[k]) { pairs.push([p + i, p + k]); i++; k++; }
      else if (dp[(i + 1) * (nn + 1) + k] >= dp[i * (nn + 1) + k + 1]) i++;
      else k++;
    }
  }
  for (let i = 0; i < s; i++) pairs.push([a.length - s + i, b.length - s + i]);
  return pairs;
}
