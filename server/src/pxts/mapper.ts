// Position mapping between a .pxts document and the ProvideX text generated from it.
import { FromPxtsResult, Segment } from './fromPxts';

export interface Pos { line: number; character: number }
export interface Rng { start: Pos; end: Pos }

export class PxtsMapper {
  private byTs = new Map<number, Segment[]>();
  private byPvx = new Map<number, Segment[]>();
  private firstPvxLineOf = new Map<number, number>();

  constructor(public res: FromPxtsResult) {
    for (const s of res.segments) {
      (this.byTs.get(s.tl) ?? this.byTs.set(s.tl, []).get(s.tl)!).push(s);
      (this.byPvx.get(s.pl) ?? this.byPvx.set(s.pl, []).get(s.pl)!).push(s);
    }
    for (const a of this.byTs.values()) a.sort((x, y) => x.tc0 - y.tc0);
    for (const a of this.byPvx.values()) a.sort((x, y) => x.pc0 - y.pc0);
    res.srcLine.forEach((tl, pl) => { if (!this.firstPvxLineOf.has(tl)) this.firstPvxLineOf.set(tl, pl); });
  }

  /** .pxts position -> ProvideX position */
  toPvx(p: Pos): Pos {
    const segs = this.byTs.get(p.line) ?? [];
    let best: Segment | undefined;
    for (const s of segs) {
      if (p.character >= s.tc0 && p.character <= s.tc1) { best = s; break; }
      if (s.tc0 <= p.character) best = s;
    }
    if (best) {
      const off = Math.max(0, Math.min(p.character - best.tc0, best.pc1 - best.pc0));
      // past the end of the nearest token: stay at its end
      return { line: best.pl, character: p.character > best.tc1 ? best.pc1 : best.pc0 + off };
    }
    const pl = this.firstPvxLineOf.get(p.line);
    if (pl !== undefined) return { line: pl, character: 0 };
    // nearest generated line above
    let l = p.line;
    while (l >= 0 && !this.firstPvxLineOf.has(l)) l--;
    return { line: l >= 0 ? this.firstPvxLineOf.get(l)! : 0, character: 0 };
  }

  /** ProvideX position -> .pxts position */
  toTs(p: Pos): Pos {
    const segs = this.byPvx.get(p.line) ?? [];
    let best: Segment | undefined;
    for (const s of segs) {
      if (p.character >= s.pc0 && p.character <= s.pc1) { best = s; break; }
      if (s.pc0 <= p.character) best = s;
    }
    if (best) {
      const off = Math.max(0, Math.min(p.character - best.pc0, best.tc1 - best.tc0));
      return { line: best.tl, character: p.character > best.pc1 ? best.tc1 : best.tc0 + off };
    }
    if (segs.length) return { line: segs[0].tl, character: segs[0].tc0 };
    return { line: this.res.srcLine[p.line] ?? 0, character: 0 };
  }

  rangeToTs(r: Rng): Rng {
    const segs = (this.byPvx.get(r.start.line) ?? []).filter((s) => s.pc0 <= r.start.character && r.start.character < s.pc1 && r.end.line === r.start.line && r.end.character <= s.pc1);
    if (segs.length) {
      // a range inside one generated token maps onto the whole source token
      const s = segs[0];
      if (r.start.character === s.pc0 && r.end.character === s.pc1) return { start: { line: s.tl, character: s.tc0 }, end: { line: s.tl, character: s.tc1 } };
    }
    const start = this.toTs(r.start);
    let end = this.toTs(r.end);
    if (end.line < start.line || (end.line === start.line && end.character < start.character)) end = start;
    if (r.start.line === r.end.line && end.line !== start.line) end = { line: start.line, character: start.character + 1 };
    return { start, end };
  }

  /** ProvideX line -> .pxts line */
  lineToTs(pl: number): number { return this.res.srcLine[pl] ?? 0; }

  segmentsOnPvxLine(pl: number): Segment[] { return this.byPvx.get(pl) ?? []; }
}
