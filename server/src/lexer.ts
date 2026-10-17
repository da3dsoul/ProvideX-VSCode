// Line-oriented lexer for ProvideX source text.
// ProvideX statements never span physical lines (blocks use { } across lines), so every line is lexed independently.

export const enum T {
  LineNumber = 'lineno',
  Label = 'label', // NAME: at statement start
  Word = 'word', // identifier / keyword (classified later)
  Number = 'number',
  String = 'string',
  HexString = 'hex',
  Mnemonic = 'mnemonic', // 'CS'
  Member = 'member', // 'Name after an object reference
  Special = 'special', // *NEXT, *SAME ...
  Operator = 'op',
  Punct = 'punct', // , ; ( ) [ ] { } :
  Comment = 'comment',
  Unknown = 'unknown',
}

export interface Token {
  kind: T;
  text: string;
  start: number; // column (UTF-16) in line
  end: number;
  upper: string; // upper-cased text (cheap to compare)
  unterminated?: boolean;
  /** { } used as an array range subscript (X{1:5}) rather than a block */
  subscript?: boolean;
  /** on ) and ]: the bracket closed a call or subscript written directly after a name */
  call?: boolean;
  // filled by the parser
  role?: Role;
}

export type Role =
  | 'directive' | 'clause' | 'function' | 'userFunction' | 'sysvar' | 'variable' | 'stringVariable' | 'integerVariable'
  | 'globalVariable' | 'fileOption' | 'labelRef' | 'lineRef' | 'labelDef' | 'method' | 'property' | 'className' | 'parameter'
  | 'objectVariable';

const WORD_START = /[A-Za-z_%]/;
const WORD_RE = /(?:FN%|fn%|Fn%|fN%)?%?[A-Za-z_][A-Za-z0-9_.]*[$%]?/y;
const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const HEX_RE = /\$[0-9A-Fa-f]*\$/y;
const OPS = ['**', '<=', '>=', '<>', '=<', '=>', '><', '+=', '-=', '*=', '/=', '^=', '++', '--', '+', '-', '*', '/', '^', '=', '<', '>', '|', '&', '@', '?', '\\', '`'];

export interface LexedLine {
  tokens: Token[];
  lineNumber?: Token;
  /** column where code begins after the statement number */
  codeStart: number;
}

function tok(kind: T, text: string, start: number): Token {
  return { kind, text, start, end: start + text.length, upper: text.toUpperCase() };
}

export function lexLine(line: string): LexedLine {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  let lineNumber: Token | undefined;

  // statement number
  const m = /^(\s*)(\d+)(?=[\s?]|$)/.exec(line);
  if (m) {
    lineNumber = tok(T.LineNumber, m[2], m[1].length);
    tokens.push(lineNumber);
    i = m[0].length;
    if (line[i] === '?') i++; // LIST marks statements with syntax errors by '?'
  }
  const codeStart = i;
  let atStmtStart = true;
  const braces: boolean[] = [];
  const parens: boolean[] = [];

  const prevSignificant = (): Token | undefined => tokens.length ? tokens[tokens.length - 1] : undefined;

  while (i < n) {
    const c = line[i];
    if (c === ' ' || c === '\t') { i++; continue; }

    // comments: '!' anywhere outside a string, or REM at statement start
    if (c === '!') {
      tokens.push(tok(T.Comment, line.slice(i), i));
      break;
    }

    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') { j += 2; continue; }
          closed = true; j++; break;
        }
        j++;
      }
      const t = tok(T.String, line.slice(i, j), i);
      if (!closed) t.unterminated = true;
      tokens.push(t);
      i = j; atStmtStart = false;
      continue;
    }

    if (c === '$') {
      HEX_RE.lastIndex = i;
      const h = HEX_RE.exec(line);
      if (h) { tokens.push(tok(T.HexString, h[0], i)); i += h[0].length; atStmtStart = false; continue; }
    }

    if (c === "'") {
      const p = prevSignificant();
      const isMember = p !== undefined && p.end === i && (p.kind === T.Word || p.kind === T.Member || (p.kind === T.Punct && (p.text === ')' || p.text === ']') && !!p.call));
      const w = /'([A-Za-z_][A-Za-z0-9_.]*[$%]?|\*)/y; // obj'Name or obj'* (all properties)
      w.lastIndex = i;
      const mm = w.exec(line);
      if (isMember && mm) {
        tokens.push(tok(T.Member, mm[0], i));
        i += mm[0].length; atStmtStart = false;
        continue;
      }
      // mnemonics may contain any character except quotes ('CS', '+E', 'F=', '! ')
      const mn = /'([^'"(),\r\n]{0,12})'/y;
      mn.lastIndex = i;
      const mnm = mn.exec(line);
      if (mnm) { tokens.push(tok(T.Mnemonic, mnm[0], i)); i += mnm[0].length; atStmtStart = false; continue; }
      if (mm) { tokens.push(tok(T.Member, mm[0], i)); i += mm[0].length; atStmtStart = false; continue; }
      tokens.push(tok(T.Unknown, c, i)); i++;
      continue;
    }

    if (c === '*' && /[A-Za-z]/.test(line[i + 1] ?? '')) {
      const p = prevSignificant();
      const operand = p && (p.kind === T.Word || p.kind === T.Number || p.kind === T.String || p.kind === T.HexString || p.kind === T.Member || (p.kind === T.Punct && (p.text === ')' || p.text === ']')));
      if (!operand || (p.kind === T.Word && /^(GOTO|GOSUB|THEN|ELSE|EXITTO|SETERR|SETESC|RETRY)$/i.test(p.text))) {
        const s = /\*[A-Za-z_][A-Za-z0-9_]*/y; s.lastIndex = i;
        const sm = s.exec(line)!;
        tokens.push(tok(T.Special, sm[0], i)); i += sm[0].length; atStmtStart = false;
        continue;
      }
    }

    if (/\d/.test(c) || (c === '.' && /\d/.test(line[i + 1] ?? ''))) {
      NUM_RE.lastIndex = i;
      const nm = NUM_RE.exec(line)!;
      // don't treat E as exponent when followed by a letter run (e.g. 1END)
      let text = nm[0];
      if (/[eE]/.test(text) && /[A-Za-z]/.test(line[i + text.length] ?? '')) text = text.replace(/[eE].*$/, '');
      tokens.push(tok(T.Number, text, i)); i += text.length; atStmtStart = false;
      continue;
    }

    if (WORD_START.test(c)) {
      WORD_RE.lastIndex = i;
      const wm = WORD_RE.exec(line);
      if (wm) {
        let text = wm[0];
        // a trailing '.' is not part of a name, except in record prefixes such as CUComp.$
        if (text.endsWith('.') && line[i + text.length] === '$') text += '$';
        else while (text.endsWith('.')) text = text.slice(0, -1);
        const end = i + text.length;
        // label definition:  NAME:   at statement start (not NAME:= / not inside expression)
        if (atStmtStart && line[end] === ':' && line[end + 1] !== '=' && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(text)) {
          tokens.push(tok(T.Label, text, i));
          tokens.push(tok(T.Punct, ':', end));
          i = end + 1;
          atStmtStart = true;
          continue;
        }
        const t = tok(T.Word, text, i);
        tokens.push(t);
        i = end;
        if (atStmtStart && t.upper === 'REM') {
          const rest = line.slice(i);
          if (rest.length) tokens.push(tok(T.Comment, rest, i));
          break;
        }
        atStmtStart = false;
        continue;
      }
    }

    if (c === '{' || c === '}') {
      const p = prevSignificant();
      if (c === '{') {
        const sub = !!p && p.end === i && (p.kind === T.Word || (p.kind === T.Punct && (p.text === ']' || p.text === ')')));
        braces.push(sub);
        const t = tok(T.Punct, sub ? '[' : '{', i);
        if (sub) t.subscript = true;
        tokens.push(t); i++;
        atStmtStart = !sub;
        continue;
      }
      const sub = braces.length ? braces.pop()! : false;
      const t = tok(T.Punct, sub ? ']' : '}', i);
      if (sub) t.subscript = true;
      tokens.push(t); i++;
      atStmtStart = false;
      continue;
    }
    if (',;()[]:'.includes(c)) {
      const t = tok(T.Punct, c, i);
      // remember whether a parenthesis belongs to a call (name directly before it): only then may ')'
      // be followed by a member access  obj'Method(x)'Prop  -- PRINT (chan)'CS' is a mnemonic
      if (c === '(' || c === '[') {
        const p = prevSignificant();
        parens.push(!!p && p.end === i && (p.kind === T.Word || p.kind === T.Member || (p.kind === T.Punct && (p.text === ')' || p.text === ']') && !!p.call)));
      } else if (c === ')' || c === ']') {
        t.call = parens.pop() ?? false;
      }
      tokens.push(t);
      i++;
      atStmtStart = c === ';' || c === '{';
      continue;
    }

    let matched = false;
    for (const op of OPS) {
      if (line.startsWith(op, i)) {
        tokens.push(tok(T.Operator, op, i));
        i += op.length; matched = true; atStmtStart = false;
        break;
      }
    }
    if (matched) continue;
    tokens.push(tok(T.Unknown, c, i));
    i++;
  }
  return { tokens, lineNumber, codeStart };
}
