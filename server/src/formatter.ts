// Document formatting: keyword casing, optional block indentation, trailing whitespace.
import { TextEdit, Range } from 'vscode-languageserver';
import { ParsedDoc } from './parser';
import { T, Token, lexLine } from './lexer';
import { parse } from './parser';

export interface FormatOptions {
  keywordCase: 'upper' | 'lower' | 'preserve';
  indentBlocks: boolean;
  indentSize: number;
  useTabs: boolean;
  /** normalize spacing around operators and after commas (ProvideX discards whitespace, so this is cosmetic) */
  spacing?: boolean;
}

const OPEN = new Set(['FOR', 'WHILE', 'REPEAT', 'SWITCH', 'TRY', 'SELECT', 'DEF CLASS']);
const CLOSE = new Set(['NEXT', 'WEND', 'UNTIL', 'END SWITCH', 'END_TRY', 'NEXT RECORD', 'END DEF']);
const MIDDLE = new Set(['CASE', 'DEFAULT', 'CATCH', 'FINALLY']);

export function formatDocument(doc: ParsedDoc, opts: FormatOptions, range?: Range): TextEdit[] {
  const edits: TextEdit[] = [];
  let level = 0;
  let inSwitchCase: boolean[] = [];
  for (let line = 0; line < doc.lines.length; line++) {
    const src = doc.lines[line];
    const lx = doc.lexed[line];
    const inRange = !range || (line >= range.start.line && line <= range.end.line);
    const stmts = doc.stmtsByLine[line] ?? [];

    // indentation level for this line
    let lineLevel = level;
    const first = stmts[0];
    if (first) {
      if (first.kind === 'BLOCK_CLOSE' || CLOSE.has(first.kind)) lineLevel = Math.max(0, level - 1);
      if (MIDDLE.has(first.kind)) lineLevel = Math.max(0, level - 1);
      if (first.kind === 'END SWITCH' && inSwitchCase[inSwitchCase.length - 1]) lineLevel = Math.max(0, level - 2);
    }
    // update level for following lines
    for (const st of stmts) {
      if (st.kind === 'BLOCK_OPEN') level++;
      else if (st.kind === 'BLOCK_CLOSE') level = Math.max(0, level - 1);
      else if (st.kind === 'SWITCH') { level++; inSwitchCase.push(false); }
      else if ((st.kind === 'CASE' || st.kind === 'DEFAULT') && inSwitchCase.length) {
        if (!inSwitchCase[inSwitchCase.length - 1]) { level++; inSwitchCase[inSwitchCase.length - 1] = true; }
      } else if (st.kind === 'END SWITCH') {
        level = Math.max(0, level - (inSwitchCase.pop() ? 2 : 1));
      } else if (OPEN.has(st.kind)) level++;
      else if (CLOSE.has(st.kind)) level = Math.max(0, level - 1);
      const last = st.tokens[st.tokens.length - 1];
      if (last && last.kind === T.Punct && last.text === '{' && st.kind !== 'BLOCK_OPEN') level++;
    }
    if (!inRange) continue;

    // keyword case
    if (opts.keywordCase !== 'preserve') {
      for (const t of lx.tokens) {
        if (t.kind !== T.Word) continue;
        if (!t.role || !['directive', 'clause', 'function', 'sysvar', 'fileOption'].includes(t.role)) continue;
        // _OBJ, _PARENT ... are case-preserved names to ProvideX, not keywords
        if (t.text.startsWith('_')) continue;
        const want = opts.keywordCase === 'upper' ? t.text.toUpperCase() : t.text.toLowerCase();
        if (want !== t.text) edits.push(TextEdit.replace(Range.create(line, t.start, line, t.end), want));
      }
      for (const t of lx.tokens) {
        if (t.kind === T.Special || t.kind === T.Mnemonic) {
          const want = opts.keywordCase === 'upper' ? t.text.toUpperCase() : t.text.toLowerCase();
          // only the branch targets are keywords; other *names (.NET interop such as *obj) keep their case
          if (t.kind === T.Special && /^\*(NEXT|SAME|RETRY|BREAK|CONTINUE|PROCEED|RETURN|END|ESCAPE)$/i.test(t.text) && want !== t.text) edits.push(TextEdit.replace(Range.create(line, t.start, line, t.end), want));
        }
      }
    }

    // indentation (only for sources without statement numbers)
    if (opts.indentBlocks && !lx.lineNumber && lx.tokens.length) {
      const cur = /^[ \t]*/.exec(src)![0];
      const want = opts.useTabs ? '\t'.repeat(lineLevel) : ' '.repeat(lineLevel * opts.indentSize);
      if (cur !== want) edits.push(TextEdit.replace(Range.create(line, 0, line, cur.length), want));
    }
    // trailing whitespace (never inside a string: strings are closed before EOL)
    const trail = /[ \t]+$/.exec(src);
    if (trail && !lx.tokens.some((t) => t.unterminated)) {
      edits.push(TextEdit.del(Range.create(line, trail.index, line, src.length)));
    }
  }
  return edits;
}

/** Formatting including spacing: returns whole-line replacements. */
export function formatDocumentFull(doc: ParsedDoc, opts: FormatOptions, range?: Range): TextEdit[] {
  const inRange = (l: number) => !range || (l >= range.start.line && l <= range.end.line);
  let lines = doc.lines;
  if (opts.spacing) lines = lines.map((l, i) => (inRange(i) ? respaceLine(l) : l));
  const doc2 = opts.spacing ? parse(lines.join('\n')) : doc;
  const edits = formatDocument(doc2, opts, range);
  const byLine = new Map<number, TextEdit[]>();
  for (const e of edits) { const x = byLine.get(e.range.start.line) ?? []; x.push(e); byLine.set(e.range.start.line, x); }
  const out: TextEdit[] = [];
  lines.forEach((l, i) => {
    let s = l;
    for (const e of (byLine.get(i) ?? []).sort((p, q) => q.range.start.character - p.range.start.character)) s = s.slice(0, e.range.start.character) + e.newText + s.slice(e.range.end.character);
    if (s !== doc.lines[i]) out.push(TextEdit.replace(Range.create(i, 0, i, doc.lines[i].length), s));
  });
  return out;
}

const BINARY = new Set(['=', '<>', '<', '>', '<=', '>=', '=<', '=>', '><', '+', '-', '*', '/', '^', '**', '+=', '-=', '*=', '/=', '^=', '|']);

/** Normalizes spacing inside one line (statement number and indentation are preserved as-is). */
export function respaceLine(line: string): string {
  const lx = lexLine(line);
  const toks = lx.tokens.filter((t) => t.kind !== T.LineNumber);
  if (!toks.length) return line;
  const lead = line.slice(0, toks[0].start);
  let out = '';
  const src = (t: Token) => line.slice(t.start, t.end);
  const isOperand = (t?: Token) => !!t && (t.kind === T.Word || t.kind === T.Number || t.kind === T.String || t.kind === T.HexString || t.kind === T.Member || t.kind === T.Mnemonic || t.kind === T.Special || (t.kind === T.Punct && (t.text === ')' || t.text === ']')));
  const isOptionName = (k: number) => {
    const t = toks[k];
    return t.kind === T.Word && /^[A-Za-z]{3}$/.test(t.text) && toks[k - 1]?.kind === T.Punct && toks[k - 1].text === ',' && toks[k + 1]?.text === '=';
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];
    if (k === 0) { out += src(t); continue; }
    const gap = line.slice(prev.end, t.start);
    let sep: string;
    const binaryHere = (x: Token, idx: number) => x.kind === T.Operator && BINARY.has(x.text) && isOperand(toks[idx - 1]) &&
      !(x.text === '=' && isOptionName(idx - 1)) && !(x.text === '*' && toks[idx + 1]?.kind === T.Punct && toks[idx + 1].text === ',' && toks[idx - 1]?.kind === T.Word && toks[idx - 1].upper === 'SELECT');
    if (t.kind === T.Comment) sep = ' ';
    else if (t.kind === T.Member) sep = '';
    else if (t.kind === T.Punct && (t.text === ')' || t.text === ']' || t.text === ',' || t.text === ';')) sep = '';
    else if (prev.kind === T.Punct && (prev.text === '(' || prev.text === '[')) sep = '';
    else if (t.kind === T.Punct && (t.text === '(' || t.text === '[' || t.text === ':')) sep = gap.length ? ' ' : '';
    else if (prev.kind === T.Punct && prev.text === ':') sep = gap.length ? ' ' : '';
    else if (prev.kind === T.Punct && (prev.text === ',' || prev.text === ';')) sep = ' ';
    else if (binaryHere(t, k)) sep = ' ';
    else if (prev.kind === T.Operator && binaryHere(prev, k - 1)) sep = ' ';
    else if (prev.kind === T.Operator) sep = gap.length ? ' ' : ''; // unary +/-, ++, @ ...
    else if (t.kind === T.Operator) sep = gap.length ? ' ' : '';
    else sep = gap.length ? ' ' : (isOperand(prev) && isOperand(t) ? ' ' : '');
    // never merge two words/numbers that were separated
    if (!sep && gap.length && /[A-Za-z0-9_$%.]$/.test(out) && /^[A-Za-z0-9_%.*]/.test(src(t))) sep = ' ';
    out += sep + src(t);
  }
  return lead + out;
}

