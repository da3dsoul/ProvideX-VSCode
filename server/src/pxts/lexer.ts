// Lexer for ProvideX/TS (.pxts): TypeScript-style syntax over ProvideX semantics.
// Tokens carry absolute (line, column) positions so translations can map back to the source.

export type TsKind = 'ident' | 'number' | 'string' | 'mnemonic' | 'raw' | 'comment' | 'op' | 'punct' | 'special' | 'eol';

export interface TsToken {
  kind: TsKind;
  text: string;
  line: number;
  col: number;
  end: number;
  /** decoded value for strings / raw blocks */
  value?: string;
  unterminated?: boolean;
  hex?: boolean;
}

const OPS = ['===', '!==', '**=', '==', '!=', '<=', '>=', '&&', '||', '**', '+=', '-=', '*=', '/=', '++', '--', '=>', '::', '+', '-', '*', '/', '%', '<', '>', '=', '!', '?', '@', '|', '&', '^', '\\'];

/** Identifier: optional % (global), letters/digits/_ and :: (ProvideX dotted names), optional $ or % suffix. */
const IDENT = /%?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*(?:::(?=\$))?[$%]?/y; // WRK::1$ (ProvideX WRK.1$) is valid

export function lexTs(text: string): TsToken[] {
  const out: TsToken[] = [];
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      const start = i;
      const push = (kind: TsKind, end: number, value?: string, unterminated?: boolean) => {
        out.push({ kind, text: s.slice(start, end), line: ln, col: start, end, value, unterminated });
        i = end;
      };
      if (c === '/' && s[i + 1] === '/') { push('comment', s.length, s.slice(i + 2)); continue; }
      if (c === '"' || c === "'") {
        // "..." and '...' are both strings (as in TypeScript)
        let j = i + 1, v = '', closed = false;
        while (j < s.length) {
          const ch = s[j];
          if (ch === '\\' && j + 1 < s.length) {
            const n = s[j + 1];
            if (n === 'x' && /^[0-9A-Fa-f]{2}$/.test(s.slice(j + 2, j + 4))) { v += String.fromCharCode(parseInt(s.slice(j + 2, j + 4), 16)); j += 4; continue; }
            v += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n === '0' ? '\0' : n;
            j += 2; continue;
          }
          if (ch === c) { closed = true; j++; break; }
          v += ch; j++;
        }
        push('string', j, v, !closed);
        // a literal made only of \xNN escapes is a ProvideX hex string ($0D0A$)
        if (/^["'](\\x[0-9A-Fa-f]{2})+["']$/.test(s.slice(start, j))) out[out.length - 1].hex = true;
        continue;
      }
      if (c === '`') {
        const j = s.indexOf('`', i + 1);
        const prev = out[out.length - 1];
        // m`CS` is a ProvideX mnemonic ('CS'); pvx`...` is raw ProvideX
        if (prev && prev.kind === 'ident' && prev.text === 'm' && prev.end === i && j > i) {
          out.pop();
          out.push({ kind: 'mnemonic', text: "'" + s.slice(i + 1, j) + "'", line: ln, col: prev.col, end: j + 1 });
          i = j + 1;
          continue;
        }
        if (j < 0) { push('raw', s.length, s.slice(i + 1), true); continue; }
        push('raw', j + 1, s.slice(i + 1, j));
        continue;
      }
      if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1] ?? ''))) {
        const m = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y; m.lastIndex = i;
        push('number', i + m.exec(s)![0].length);
        continue;
      }
      if (c === '*' && /[A-Za-z_]/.test(s[i + 1] ?? '')) {
        const prev = out[out.length - 1];
        const operand = prev && prev.line === ln && (prev.kind === 'ident' || prev.kind === 'number' || prev.kind === 'string' || (prev.kind === 'punct' && (prev.text === ')' || prev.text === ']')));
        if (!operand) { const m = /\*[A-Za-z_][A-Za-z0-9_]*/y; m.lastIndex = i; push('special', i + m.exec(s)![0].length); continue; }
      }
      if (/[A-Za-z_%]/.test(c)) {
        IDENT.lastIndex = i;
        const m = IDENT.exec(s);
        if (m) { push('ident', i + m[0].length); continue; }
      }
      if ('(){}[],;:.'.includes(c) && !(c === ':' && s[i + 1] === ':')) { push('punct', i + 1); continue; }
      const op = OPS.find((o) => s.startsWith(o, i));
      if (op) { push('op', i + op.length); continue; }
      push('op', i + 1);
    }
    out.push({ kind: 'eol', text: '', line: ln, col: s.length, end: s.length });
  }
  return out;
}

/** Encodes a string value as a ProvideX string expression: "..." with "" escapes, hex strings for control characters. */
export function pvxString(v: string): string {
  if (v === '') return '""';
  const parts: string[] = [];
  let run = '', hex = '';
  const flushRun = () => { if (run) { parts.push('"' + run.replace(/"/g, '""') + '"'); run = ''; } };
  const flushHex = () => { if (hex) { parts.push('$' + hex + '$'); hex = ''; } };
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    // only line breaks cannot sit inside a ProvideX string literal; other control characters stay as written
    if (code === 10 || code === 13 || code > 255) { flushRun();hex += (code > 255 ? 63 : code).toString(16).toUpperCase().padStart(2, '0'); }
    else { flushHex(); run += ch; }
  }
  flushRun(); flushHex();
  // mixed text and control characters: one hex literal (a constant, valid wherever a literal is, e.g. DATA)
  return parts.length === 1 ? parts[0] : hexLiteral(v);
}

/** A ProvideX hex string as a .pxts literal of \x escapes (kept as hex on the way back). */
export function tsHex(v: string): string {
  if (!v) return '""';
  return '"' + [...v].map((c) => '\\x' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('') + '"';
}

export function hexLiteral(v: string): string {
  return '$' + [...v].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('') + '$';
}

/** Encodes a ProvideX string/hex literal value as a .pxts string literal. */
export function tsString(v: string): string {
  let s = '"';
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    if (ch === '"') s += '\\"';
    else if (ch === '\\') s += '\\\\';
    else if (ch === '\n') s += '\\n';
    else if (ch === '\r') s += '\\r';
    else if (ch === '\t') s += '\\t';
    else if (code < 32 || code === 127) s += '\\x' + code.toString(16).toUpperCase().padStart(2, '0');
    else s += ch;
  }
  return s + '"';
}
