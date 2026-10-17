// Keeps a class's ProvideX layout when a .pxts file is saved back over an existing program.
// ProvideX/TS writes a class as fields + methods, so on the way back the header declarations (FUNCTION, PROPERTY,
// LOCAL, LIKE) and the comments around them are regenerated in method order. Their order has no meaning, so
// lines that only moved are put back where the original program had them; everything else stays as written.
// Code never crosses a class's END DEF: header lines stay in the header, code stays in the method sections.
import { lcs } from '../view';
import { lexLine, T } from '../lexer';

/**
 * Canonical form for matching: tokens only, without LET and without the parentheses ProvideX/TS drops around a whole
 * IF / WHILE / UNTIL / SWITCH condition (`IF (x) THEN` and `IF x THEN` are the same statement).
 */
export function eqNorm(s: string): string {
  const toks = lexLine(s).tokens.filter((t) => t.kind !== T.LineNumber);
  let p = toks.map((t) => (t.kind === T.HexString && t.text === '$$' ? '""' : t.kind === T.String || t.kind === T.Comment ? t.text.trimEnd() : t.upper)); // $$ is ""
  p = p.filter((x, k) => !(x === 'LET' && (k === 0 || ['THEN', 'ELSE', ';', '{', '}'].includes(p[k - 1]))));
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 0; k + 1 < p.length; k++) {
      if (!['IF', 'WHILE', 'UNTIL', 'SWITCH'].includes(p[k]) || p[k + 1] !== '(') continue;
      let d = 0, e = k + 1;
      for (; e < p.length; e++) { if (p[e] === '(') d++; else if (p[e] === ')') { d--; if (d === 0) break; } }
      const after = p[e + 1];
      if (e < p.length && (after === undefined || after === 'THEN' || after === '{' || after === ';' || after.startsWith('!'))) {
        p.splice(e, 1); p.splice(k + 1, 1); changed = true;
      }
    }
  }
  return p.join(' ');
}

const HEADER_DECL = /^(FUNCTION|PROPERTY|LOCAL|LIKE)\b/;
const isComment = (n: string) => n.startsWith('!') || n.startsWith('REM');
const isClass = (n: string) => /^DEF CLASS\b/.test(n);
const isEnd = (n: string) => /^END DEF\b/.test(n);

interface Region { head: number; end: number; stop: number } // DEF CLASS line, END DEF line, first line after the region

/** Classes of a readable program: DEF CLASS .. END DEF, then the implementation up to the next DEF CLASS. */
function regions(norm: string[]): Region[] {
  const out: Region[] = [];
  for (let i = 0; i < norm.length; i++) {
    if (!isClass(norm[i])) continue;
    let e = i + 1;
    while (e < norm.length && !isEnd(norm[e]) && !isClass(norm[e])) e++;
    if (e >= norm.length || !isEnd(norm[e])) continue;
    let s = e + 1;
    while (s < norm.length && !isClass(norm[s])) s++;
    out.push({ head: i, end: e, stop: s });
    i = e;
  }
  return out;
}

const range = (a: number, z: number) => Array.from({ length: Math.max(0, z - a) }, (_, k) => a + k);

/** Returns the aligned text and, for each of its lines, the line of viewText it came from. */
export function alignToBase(viewText: string, baseText: string): { text: string; from: number[] } {
  const baseLines = baseText.split(/\r?\n/);
  const merged = mergeLikes(viewText.split(/\r?\n/), baseLines);
  const r = align(merged.lines, baseLines);
  return { text: r.text, from: r.from.map((j) => merged.from[j]) };
}

/**
 * ProvideX/TS lifts LIKE statements into `extends A, B`, so they come back one per line with their comments on lines
 * of their own. Where the original wrote  LIKE "A","B" ! note  they are joined again.
 */
function mergeLikes(lines: string[], baseLines: string[]): { lines: string[]; from: number[] } {
  const parse = (l: string) => {
    const m = /^\s*LIKE\s+([^!]*?)\s*(!.*)?$/i.exec(l);
    return m ? { names: m[1].split(',').map((x) => x.trim().toUpperCase()), comment: m[2]?.trim() } : undefined;
  };
  const likes = baseLines.map((l, i) => ({ p: parse(l), i })).filter((x) => x.p && (x.p.names.length > 1 || x.p.comment));
  if (!likes.length) return { lines, from: lines.map((_, j) => j) };
  const usedBase = new Set<number>(), dropped = new Set<number>();
  const replaced = new Map<number, string>();
  for (let j = 0; j < lines.length; j++) {
    const n = parse(lines[j]);
    if (!n || n.names.length !== 1 || n.comment) continue;
    const m = likes.find((x) => !usedBase.has(x.i) && x.p!.names[0] === n.names[0] && x.p!.names.every((nm, k) => { const q = parse(lines[j + k] ?? ''); return q && !q.comment && q.names.join() === nm; }));
    if (!m) continue;
    let c: number | undefined;
    if (m.p!.comment) {
      for (let k = j + 1; k < lines.length && !/^\s*END\s*DEF\b/i.test(lines[k]); k++) if (!dropped.has(k) && lines[k].trim() === m.p!.comment) { c = k; break; }
      if (c === undefined) continue;
      dropped.add(c);
    }
    usedBase.add(m.i);
    replaced.set(j, lines[j].replace(/LIKE\s+.*$/i, baseLines[m.i].trim()));
    for (let k = 1; k < m.p!.names.length; k++) dropped.add(j + k);
    j += m.p!.names.length - 1;
  }
  const outL: string[] = [], from: number[] = [];
  lines.forEach((l, j) => { if (!dropped.has(j)) { outL.push(replaced.get(j) ?? l); from.push(j); } });
  return { lines: outL, from };
}

function align(lines: string[], baseLines: string[]): { text: string; from: number[] } {
  const viewText = lines.join('\n');
  const B = baseLines.map(eqNorm), N = lines.map(eqNorm);
  const rb = regions(B), rn = regions(N);
  const order: number[] = []; // line indexes of the new text, in output order
  let pos = 0;
  for (const r of rn) {
    for (; pos < r.head; pos++) order.push(pos);
    pos = r.stop;
    const b = rb.find((x) => B[x.head] === N[r.head]);
    if (!b) { order.push(...range(r.head, r.stop)); continue; }
    const Hn = range(r.head + 1, r.end), In = range(r.end + 1, r.stop);
    const Hb = range(b.head + 1, b.end), Ib = range(b.end + 1, b.stop);
    // movable lines of the new class (comments anywhere, declarations of the header), by canonical text
    const pool = new Map<string, number[]>();
    for (const j of [...Hn, ...In]) if (N[j] && (isComment(N[j]) || (j < r.end && HEADER_DECL.test(N[j])))) pool.set(N[j], [...(pool.get(N[j]) ?? []), j]);
    const used = new Set<number>();
    const take = (key: string, pred: (j: number) => boolean) => {
      const c = pool.get(key);
      const k = c ? c.findIndex((j) => !used.has(j) && pred(j)) : -1;
      if (k < 0) return undefined;
      const j = c!.splice(k, 1)[0];
      used.add(j);
      return j;
    };
    // 1. the header in its original order (a comment may come from the new implementation part)
    const header: number[] = [];
    for (const i of Hb) {
      if (!B[i]) continue;
      const j = take(B[i], (x) => x < r.end) ?? (isComment(B[i]) ? take(B[i], () => true) : undefined);
      if (j !== undefined) header.push(j);
    }
    // 2. the implementation: code keeps its order; comments that were here come back to their place
    const implLeft = In.filter((j) => !used.has(j));
    const matched = new Map<number, number>(); // base line -> new line
    for (const [a, c] of lcs(Ib.map((i) => B[i]), implLeft.map((j) => N[j]))) matched.set(Ib[a], implLeft[c]);
    for (const j of matched.values()) used.add(j);
    const after = new Map<number, number[]>(); // new line (-1: start) -> comments to put after it
    let prev = -1;
    for (const i of Ib) {
      const m = matched.get(i);
      if (m !== undefined) { prev = m; continue; }
      if (!B[i] || !isComment(B[i])) continue;
      const j = take(B[i], () => true);
      if (j === undefined) continue;
      after.set(prev, [...(after.get(prev) ?? []), j]);
      prev = j;
    }
    const movedIn = new Set([...after.values()].flat());
    // 3. new or edited header lines stay in the header, after the line they followed
    for (const j of Hn) {
      if (used.has(j) && (header.includes(j) || movedIn.has(j))) continue;
      const before = Hn.slice(0, Hn.indexOf(j)).reverse().find((x) => header.includes(x));
      header.splice(before === undefined ? 0 : header.indexOf(before) + 1, 0, j);
      used.add(j);
    }
    order.push(r.head, ...header, r.end);
    const headerSet = new Set(header);
    const emitAfter = (j: number) => { for (const x of after.get(j) ?? []) { order.push(x); emitAfter(x); } };
    emitAfter(-1);
    for (const j of In) {
      if (headerSet.has(j) || movedIn.has(j)) continue;
      order.push(j);
      emitAfter(j);
    }
  }
  for (; pos < lines.length; pos++) order.push(pos);
  // safety net: every line exactly once, or nothing is rearranged
  if (new Set(order).size !== lines.length || order.length !== lines.length) return { text: viewText, from: range(0, lines.length) };
  // lines that match the original take its spelling (parentheses, LET, spacing)
  const spelled: (string | undefined)[] = new Array(order.length).fill(undefined);
  for (const [i, k] of lcs(B, order.map((j) => N[j]))) spelled[k] = baseLines[i];
  // blank lines inside classes that the original did not have are dropped (ProvideX ignores them anyway)
  const inClass = new Set(rn.flatMap((r) => range(r.head, r.stop)));
  const keep = order.map((j, k) => !(N[j] === '' && spelled[k] === undefined && inClass.has(j)));
  return { text: order.map((j, k) => spelled[k] ?? lines[j]).filter((_, k) => keep[k]).join('\n'), from: order.filter((_, k) => keep[k]) };
}
