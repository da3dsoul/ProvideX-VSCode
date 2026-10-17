// Semantic checks on top of the parser output.
import { ParsedDoc, Problem, Stmt } from './parser';
import { T, Token } from './lexer';
import { functionDoc, isKnownFunction } from './lexicon';

export interface AnalyzerOptions {
  undefinedLabels: boolean;
  unusedLabels: boolean;
  blockStructure: boolean;
}

export function analyze(doc: ParsedDoc, opts: AnalyzerOptions): Problem[] {
  const out: Problem[] = [];
  for (const p of doc.problems) {
    if (!opts.blockStructure && (p.code === 'block-structure')) continue;
    out.push(p);
  }

  // duplicate labels (ProvideX Error #56)
  for (const defs of doc.labels.values()) {
    if (defs.length > 1) for (const d of defs.slice(1)) out.push({ span: d.span, message: `Duplicate statement label ${d.name} (Error #56)`, severity: 'error', code: 'duplicate-label' });
  }

  // undefined label / statement references (Error #55 / #21)
  if (opts.undefinedLabels) {
    for (const r of doc.refs) {
      if (r.kind === 'label') {
        if (!doc.labels.has(r.target)) out.push({ span: { line: r.line, start: r.token.start, end: r.token.end }, message: `Cannot locate statement label ${r.token.text} (Error #55)`, severity: 'error', code: 'undefined-label', data: { label: r.token.text } });
      } else if (!doc.numbered && doc.lineNumbers.size === 0) {
        out.push({ span: { line: r.line, start: r.token.start, end: r.token.end }, message: `This code has no statement numbers, so ${r.token.text} refers to an automatically assigned number. Jump to a label instead.`, severity: 'warning', code: 'numeric-ref-lineless' });
      } else if (doc.numbered) {
        const n = parseInt(r.target, 10);
        if (!doc.lineNumbers.has(n)) {
          // like other Business BASICs, ProvideX transfers control to the next higher statement
          const next = nextStatementNumber(doc, n);
          const sp = { line: r.line, start: r.token.start, end: r.token.end };
          if (next === undefined) out.push({ span: sp, message: `Statement ${r.target} does not exist and there is no higher statement (Error #21)`, severity: 'error', code: 'undefined-line' });
          else out.push({ span: sp, message: `Statement ${r.target} does not exist; control passes to statement ${next}`, severity: 'hint', code: 'missing-line' });
        }
      }
    }
  }

  if (opts.unusedLabels) {
    const used = new Set(doc.refs.filter((r) => r.kind === 'label').map((r) => r.target));
    for (const [k, defs] of doc.labels) if (!used.has(k)) for (const d of defs) out.push({ span: d.span, message: `Label ${d.name} is never referenced`, severity: 'hint', code: 'unused-label' });
  }

  // DEF FNABS / FNFIB ...: ProvideX reads FN + built-in function name as a call of the built-in (verified on 9.62)
  for (const fn of doc.fns.values()) {
    const base = fn.name.replace(/^FN%?/i, '').replace(/[$%]$/, '').toUpperCase();
    if (!/[$]$/.test(fn.name) && isKnownFunction(base)) out.push({ span: fn.span, message: `${fn.name} cannot be used: ProvideX reads it as FN + ${base}() (built-in function). Choose another name.`, severity: 'error', code: 'fn-builtin-name' });
  }

  // built-in function argument counts
  for (const st of doc.stmts) checkCalls(st, out);

  return out;
}

export function nextStatementNumber(doc: ParsedDoc, n: number): number | undefined {
  let best: number | undefined;
  for (const k of doc.lineNumbers.keys()) if (k > n && (best === undefined || k < best)) best = k;
  return best;
}

function checkCalls(st: Stmt, out: Problem[]) {
  const toks = st.tokens;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.role !== 'function') continue;
    const fd = functionDoc(t.upper);
    if (!fd?.signatures?.length || fd.unverified) continue;
    if (!(toks[k + 1]?.kind === T.Punct && toks[k + 1].text === '(')) continue;
    const args = countArgs(toks, k + 1);
    if (args === undefined) {
      out.push({ span: { line: st.line, start: t.start, end: t.end }, message: `Missing ")" for ${t.upper}(`, severity: 'error', code: 'paren' });
      continue;
    }
    const val = (fd as { validation?: { signatures?: { extraArgRejected?: boolean; fewerArgRejected?: boolean }[] } }).validation?.signatures ?? [];
    const checkMax = !val.some((v) => v?.extraArgRejected === false);
    const checkMin = !val.some((v) => v?.fewerArgRejected === false);
    const min = Math.min(...fd.signatures.map((s) => s.minArgs ?? s.params.length));
    const max = Math.max(...fd.signatures.map((s) => (s.maxArgs === null ? Infinity : s.maxArgs ?? s.params.length)));
    if ((checkMin && args.count < min) || (checkMax && args.count > max)) {
      const range = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}-${max}`;
      out.push({ span: { line: st.line, start: t.start, end: args.end }, message: `${t.upper}() expects ${range} argument${max === 1 ? '' : 's'} but got ${args.count}`, severity: 'warning', code: 'arity' });
    }
  }
}

/** Counts top-level arguments of a call starting at the '(' token; I/O options (ERR=, END=, ...) are not counted. */
export function countArgs(toks: Token[], open: number): { count: number; end: number } | undefined {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  let optionArg = false;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind === T.Punct && (t.text === '(' || t.text === '[')) {
      depth++;
      if (depth === 1) continue;
    } else if (t.kind === T.Punct && (t.text === ')' || t.text === ']')) {
      depth--;
      if (depth === 0) {
        if (sawToken && !optionArg) count++;
        return { count, end: t.end };
      }
    } else if (depth === 1 && t.kind === T.Punct && t.text === ',') {
      if (sawToken && !optionArg) count++;
      sawToken = false; optionArg = false;
      continue;
    }
    if (depth === 1 && !sawToken && t.role === 'fileOption') optionArg = true;
    if (depth >= 1) sawToken = true;
  }
  return undefined;
}
