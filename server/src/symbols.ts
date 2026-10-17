// Symbol resolution helpers shared by the language features.
import { ParsedDoc, Span, tokenAt, ClassDef } from './parser';
import { T, Token } from './lexer';

export type SymbolRef =
  | { kind: 'label'; name: string; token: Token; line: number }
  | { kind: 'lineno'; n: number; token: Token; line: number }
  | { kind: 'variable'; name: string; token: Token; line: number }
  | { kind: 'fn'; name: string; token: Token; line: number }
  | { kind: 'member'; name: string; token: Token; line: number; object?: Token; isMethod: boolean }
  | { kind: 'class'; name: string; token: Token; line: number }
  | { kind: 'builtin'; name: string; token: Token; line: number; role: string }
  | { kind: 'program'; name: string; token: Token; line: number };

export function symbolAt(doc: ParsedDoc, line: number, col: number): SymbolRef | undefined {
  const t = tokenAt(doc, line, col);
  if (!t) return undefined;
  const lx = doc.lexed[line];
  const idx = lx.tokens.indexOf(t);
  switch (t.kind) {
    case T.Label: return { kind: 'label', name: t.text, token: t, line };
    case T.LineNumber: return { kind: 'lineno', n: parseInt(t.text, 10), token: t, line };
    case T.Member: {
      // walk back to the object expression start (e.g. coSession'FileObj'Method -> the word before the chain)
      let j = idx - 1;
      while (j >= 0 && (lx.tokens[j].kind === T.Member || (lx.tokens[j].kind === T.Punct && (lx.tokens[j].text === ')' || lx.tokens[j].text === ']')))) {
        if (lx.tokens[j].kind === T.Punct) {
          // skip balanced parens
          let d = 0;
          for (; j >= 0; j--) {
            const tt = lx.tokens[j];
            if (tt.kind === T.Punct && (tt.text === ')' || tt.text === ']')) d++;
            else if (tt.kind === T.Punct && (tt.text === '(' || tt.text === '[')) { d--; if (d === 0) { j--; break; } }
          }
        } else j--;
      }
      const object = j >= 0 && lx.tokens[j].kind === T.Word ? lx.tokens[j] : undefined;
      const directObj = idx > 0 && lx.tokens[idx - 1].kind === T.Word ? lx.tokens[idx - 1] : undefined;
      return { kind: 'member', name: t.text.slice(1), token: t, line, object: directObj ?? (idx === j + 1 ? object : undefined), isMethod: lx.tokens[idx + 1]?.text === '(' };
    }
    case T.Number:
      if (t.role === 'lineRef') return { kind: 'lineno', n: parseInt(t.text, 10), token: t, line };
      return undefined;
    case T.String:
      if (t.role === 'className') return { kind: 'class', name: t.text.slice(1, -1), token: t, line };
      {
        const link = doc.links.find((l) => l.span.line === line && l.span.start === t.start);
        if (link) return { kind: 'program', name: link.target, token: t, line };
        // NEW("Class")
        const prev = lx.tokens[idx - 1], prev2 = lx.tokens[idx - 2];
        if (prev?.text === '(' && prev2?.upper === 'NEW') return { kind: 'class', name: t.text.slice(1, -1), token: t, line };
      }
      return undefined;
    case T.Word:
      switch (t.role) {
        case 'labelRef': return { kind: 'label', name: t.text, token: t, line };
        case 'labelDef': return { kind: 'label', name: t.text, token: t, line };
        case 'userFunction': return { kind: 'fn', name: t.text, token: t, line };
        case 'method': return { kind: 'member', name: t.text, token: t, line, isMethod: true };
        case 'property':
          if (lx.tokens[idx - 1]?.kind === T.Member) return { kind: 'member', name: t.text, token: t, line, isMethod: false };
          return { kind: 'variable', name: t.text, token: t, line };
        case 'function': case 'directive': case 'clause': case 'sysvar': case 'fileOption':
          return { kind: 'builtin', name: t.upper, token: t, line, role: t.role };
        default:
          return { kind: 'variable', name: t.text, token: t, line };
      }
    case T.Mnemonic: return { kind: 'builtin', name: t.text, token: t, line, role: 'mnemonic' };
    case T.Special: return { kind: 'builtin', name: t.upper, token: t, line, role: 'special' };
    case T.Operator:
      if (t.text === '?') return { kind: 'builtin', name: 'PRINT', token: t, line, role: 'directive' };
      return undefined;
    default: return undefined;
  }
}

export function labelDef(doc: ParsedDoc, name: string): Span | undefined {
  return doc.labels.get(name.toUpperCase())?.[0]?.span;
}

export function lineDef(doc: ParsedDoc, n: number): Span | undefined {
  const l = doc.lineNumbers.get(n);
  if (l === undefined) return undefined;
  const t = doc.lexed[l].lineNumber!;
  return { line: l, start: t.start, end: t.end };
}

/** Spans of every occurrence of a label (definition + references). */
export function labelOccurrences(doc: ParsedDoc, name: string): { span: Span; def: boolean }[] {
  const key = name.toUpperCase();
  const out: { span: Span; def: boolean }[] = (doc.labels.get(key) ?? []).map((d) => ({ span: d.span, def: true }));
  for (const r of doc.refs) if (r.kind === 'label' && r.target === key) out.push({ span: { line: r.line, start: r.token.start, end: r.token.end }, def: false });
  return out;
}

export function lineOccurrences(doc: ParsedDoc, n: number): { span: Span; def: boolean }[] {
  const out: { span: Span; def: boolean }[] = [];
  const d = lineDef(doc, n);
  if (d) out.push({ span: d, def: true });
  for (const r of doc.refs) if (r.kind === 'line' && parseInt(r.target, 10) === n) out.push({ span: { line: r.line, start: r.token.start, end: r.token.end }, def: false });
  return out;
}

export function varOccurrences(doc: ParsedDoc, name: string): { span: Span; def: boolean }[] {
  const v = doc.vars.get(name.toUpperCase());
  if (!v) return [];
  return [...v.defs.map((s) => ({ span: s, def: true })), ...v.refs.map((s) => ({ span: s, def: false }))].sort((a, b) => a.span.line - b.span.line || a.span.start - b.span.start);
}

export function fnOccurrences(doc: ParsedDoc, name: string): { span: Span; def: boolean }[] {
  const key = name.toUpperCase();
  const out: { span: Span; def: boolean }[] = [];
  doc.lexed.forEach((lx, line) => {
    for (const t of lx.tokens) if (t.role === 'userFunction' && t.upper === key) {
      const def = doc.fns.get(key);
      out.push({ span: { line, start: t.start, end: t.end }, def: !!def && def.span.line === line && def.span.start === t.start });
    }
  });
  return out;
}

/** Occurrences of a member name (obj'Name / FUNCTION Name / PROPERTY Name) in a document. */
export function memberOccurrences(doc: ParsedDoc, name: string): { span: Span; def: boolean }[] {
  const key = name.toUpperCase();
  const out: { span: Span; def: boolean }[] = [];
  doc.lexed.forEach((lx, line) => {
    for (const t of lx.tokens) {
      if (t.kind === T.Member && t.upper.slice(1) === key) out.push({ span: { line, start: t.start + 1, end: t.end }, def: false });
    }
  });
  for (const c of doc.classes) for (const m of c.members) if (m.name.toUpperCase() === key) out.push({ span: m.span, def: true });
  return out;
}

/** The class whose methods contain a given line (by label ownership), or the file's only class. */
export function enclosingClass(doc: ParsedDoc): ClassDef | undefined {
  return doc.classes[0];
}

/** Infers the class of an object variable from assignments like  X=NEW("Class",...)  in the document. */
export function inferObjectClass(doc: ParsedDoc, varName: string): string | undefined {
  const key = varName.toUpperCase();
  if (key === '_OBJ') return enclosingClass(doc)?.name;
  for (const st of doc.stmts) {
    const toks = st.tokens;
    for (let k = 0; k + 4 < toks.length; k++) {
      if (toks[k].kind === T.Word && toks[k].upper === key && toks[k + 1].text === '=' && toks[k + 2].upper === 'NEW' && toks[k + 3].text === '(' && toks[k + 4].kind === T.String) {
        return toks[k + 4].text.slice(1, -1);
      }
    }
  }
  return undefined;
}

/** Comment lines directly above a line (used as documentation for labels / members). */
export function leadingComments(doc: ParsedDoc, line: number, max = 8): string[] {
  const out: string[] = [];
  for (let l = line - 1; l >= 0 && out.length < max; l--) {
    const toks = doc.lexed[l].tokens.filter((t) => t.kind !== T.LineNumber);
    if (toks.length === 1 && toks[0].kind === T.Comment) {
      out.unshift(toks[0].text.replace(/^!\s?|^REM\s?/i, ''));
      continue;
    }
    if (toks.length === 2 && toks[0].upper === 'REM' && toks[1].kind === T.Comment) { out.unshift(toks[1].text.trim()); continue; }
    if (toks.length === 0 && out.length === 0) continue;
    break;
  }
  return out.filter((s) => s.trim() && !/^[-=*!#~_\s]+$/.test(s));
}

/** Trailing comment on a line. */
export function trailingComment(doc: ParsedDoc, line: number): string | undefined {
  const toks = doc.lexed[line]?.tokens ?? [];
  const c = toks.find((t) => t.kind === T.Comment);
  if (!c) return undefined;
  const others = toks.filter((t) => t.kind !== T.Comment && t.kind !== T.LineNumber);
  return others.length ? c.text.replace(/^!\s?/, '') : undefined;
}
