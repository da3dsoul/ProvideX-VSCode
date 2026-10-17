// Verifies the readable view against the real ProvideX (needs PVX_HOME). Run:
//   npx esbuild test/view-verify.ts --bundle --platform=node --outfile=out/view-verify.js && node out/view-verify.js <corpusDir> [maxFiles]
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProvideXBridge } from '../server/src/bridge';
import { toView, fromView, respaceLine, defaultViewOptions } from '../server/src/view';
import { parse } from '../server/src/parser';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
import { formatDocument } from '../server/src/formatter';

const home = process.env.PVX_HOME!;
const corpus = process.argv[2];
const maxFiles = Number(process.argv[3] ?? 200);
const bridge = new ProvideXBridge(path.join(__dirname, '..', 'bridge', 'pvxbridge.ps1'), () => home, () => undefined);

const canon = async (text: string) => (await bridge.check(text, true));

function cosmetic(numberedText: string): string {
  // spacing + keyword case (lower, to prove case is irrelevant) applied after the statement numbers
  const lines = numberedText.split(/\r?\n/).map((l) => respaceLine(l));
  const doc = parse(lines.join('\n'));
  const edits = formatDocument(doc, { keywordCase: 'lower', indentBlocks: false, indentSize: 2, useTabs: false });
  const out = [...lines];
  const byLine = new Map<number, typeof edits>();
  for (const e of edits) { const a = byLine.get(e.range.start.line) ?? []; a.push(e); byLine.set(e.range.start.line, a); }
  for (const [l, es] of byLine) {
    let s = out[l];
    for (const e of es.sort((a, b) => b.range.start.character - a.range.start.character)) s = s.slice(0, e.range.start.character) + e.newText + s.slice(e.range.end.character);
    out[l] = s;
  }
  return out.join('\n');
}

async function runtimeChecks() {
  // each program accumulates a trace in R$; the transformed program must produce the same trace
  const progs: string[][] = [
    ['0010 R$=""; X=0; N=0', '0020 N=N+1; IF X=0 THEN R$=R$+"a"; X=1; GOTO 0040 ELSE R$=R$+"b"; GOTO 0050', '0030 R$=R$+"never"', '0040 R$=R$+"c"; IF N<2 THEN GOTO 0020', '0050 R$=R$+"d"', '0060 END'],
    ['0010 R$=""', '0020 FOR I=1 TO 3; R$=R$+STR(I); NEXT I', '0030 ON 2 GOTO 0040,0050,0060', '0040 R$=R$+"x"', '0050 R$=R$+"y"', '0060 R$=R$+"z"', '0070 END'],
    ['0010 R$=""; F=0', '0020 OPEN (1,ERR=0040)"C:\\NO_SUCH_DIR\\NO_SUCH_FILE.XYZ"', '0030 R$=R$+"opened"', '0040 R$=R$+"e"+STR(ERR)', '0050 IF F=0 THEN F=1; GOSUB 0100; GOTO 0035', '0060 R$=R$+"end"', '0070 END', '0100 R$=R$+"sub"; RETURN'],
    ['0010 R$=""; A=1; B=0', '0020 IF A THEN IF B THEN R$=R$+"1" ELSE R$=R$+"2"; R$=R$+"3"', '0030 IF NOT(A) THEN R$=R$+"4" ELSE IF B THEN R$=R$+"5" ELSE R$=R$+"6"; R$=R$+"7"', '0040 END'],
    ['0010 R$=""; X=5', '0020 WHILE X>0; X=X-2; R$=R$+STR(X); WEND', '0030 SWITCH X', '0040 CASE -1; R$=R$+"m"; BREAK', '0050 DEFAULT; R$=R$+"d"', '0060 END SWITCH', '0070 END'],
    ['0010 R$=""; A=1', '0020 IF A THEN { R$=R$+"t" } ELSE R$=R$+"e"; R$=R$+"f"', '0030 END'],
    ['0010 R$=""', '0020 FOR A=0 TO 1; FOR B=0 TO 1', '0030 IF A THEN R$=R$+"1"; IF B THEN R$=R$+"2" ELSE R$=R$+"3" END_IF ; R$=R$+"4" ELSE R$=R$+"5"', '0040 IF B THEN R$=R$+"x" END_IF ; R$=R$+"|"', '0050 NEXT B; NEXT A', '0060 END'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvxview-'));
  let fails = 0;
  for (let i = 0; i < progs.length; i++) {
    const original = progs[i];
    const view = toView(original);
    const back = fromView(view.text);
    const runIt = async (lines: string[], name: string) => {
      const out = path.join(tmp, `p${i}_${name}.pvc`);
      const c = await bridge.compile(lines.join('\n'), out);
      if (!c.saved) return 'COMPILE FAILED ' + JSON.stringify(c.diagnostics);
      await bridge.call('exec', { command: `LOAD "${out}"` });
      try { await bridge.call('exec', { command: 'RUN' }); } catch { /* END from command mode */ }
      return bridge.evaluate('R$');
    };
    const a = await runIt(original, 'orig');
    const b = await runIt(back.numbered, 'view');
    const viaTs = fromView(fromPxts(toPxts(view.text).text).text).numbered;
    const c = await runIt(viaTs, 'ts');
    const ok = a === b && a === c;
    if (!ok) fails++;
    console.log(`runtime #${i}: ${ok ? 'same' : 'DIFFERENT'}  original=${JSON.stringify(a)} view=${JSON.stringify(b)} ts=${JSON.stringify(c)}`);
    if (!ok || process.env.SHOW) console.log(view.text.split('\n').map((l) => '      | ' + l).join('\n'));
  }
  return fails;
}

async function main() {
  await bridge.info();
  const rtFails = await runtimeChecks();
  const files = fs.readdirSync(corpus, { recursive: true } as never).map(String).filter((f) => f.endsWith('.pvx')).slice(0, maxFiles);
  let editRenumbered = 0, editBad = 0;
  let cosmeticOk = 0, cosmeticBad = 0, structOk = 0, structBad = 0, preserved = 0, total = 0;
  const samples: string[] = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(corpus, rel), 'latin1');
    if (text.split('\n').some((l) => /^\d+\?/.test(l))) continue; // programs that already contain syntax errors
    const orig = await canon(text);
    // 1. cosmetic: identical canonical listing
    const cos = await canon(cosmetic(text));
    // trailing spaces inside comments are dropped on purpose
    const norm = (x?: string) => (x ?? '').replace(/\s+$/, '');
    const same = cos.canonical.length === orig.canonical.length && cos.canonical.every((c, k) => norm(c.text) === norm(orig.canonical[k].text));
    if (same) cosmeticOk++; else { cosmeticBad++; if (samples.length < 8) { const k = cos.canonical.findIndex((c, x) => c.text !== orig.canonical[x]?.text); samples.push(`${rel}: cosmetic diff\n   orig: ${orig.canonical[k]?.text}\n   new : ${cos.canonical[k]?.text}`); } }
    // 2. structural: view -> numbered compiles without syntax errors, original numbers kept
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const view = toView(lines);
    const back = fromView(view.text, view);
    const st = await canon(back.numbered.join('\n'));
    // only errors the original does not already have (e.g. .NET *OBJ syntax the COM checker rejects)
    const origBad = orig.diagnostics.length;
    if (st.diagnostics.length <= origBad && !st.mergeError) structOk++;
    else { structBad++; if (samples.length < 16) { const d = st.diagnostics[0]; samples.push(`${rel}: view does not compile: ${st.mergeError ?? ''} line ${d?.line}: ${back.numbered[d?.line ?? 0]}`); } }
    // 3. an edit in the middle only renumbers locally
    const vl = view.text.split('\n');
    const mid = Math.floor(vl.length / 2);
    const edited = [...vl.slice(0, mid), 'PRINT "inserted"', 'PRINT "inserted 2"', ...vl.slice(mid)].join('\n');
    const back2 = fromView(edited, view);
    editRenumbered += back2.renumbered;
    const st2 = await canon(back2.numbered.join('\n'));
    if (st2.diagnostics.length > origBad || st2.mergeError) { editBad++; if (samples.length < 16) samples.push(`${rel}: edited view does not compile: ${JSON.stringify(st2.diagnostics[0])} ${back2.numbered[st2.diagnostics[0]?.line ?? 0]}`); }
    const origNums = new Set(lines.map((l) => parseInt(l, 10)).filter((x) => !isNaN(x)));
    const kept = back.numbered.filter((l) => origNums.has(parseInt(l, 10))).length;
    preserved += kept; total += origNums.size;
  }
  console.log(`\nruntime equivalence: ${rtFails === 0 ? 'all same' : rtFails + ' DIFFERENT'}`);
  console.log(`cosmetic invariance: ${cosmeticOk} identical, ${cosmeticBad} different`);
  console.log(`structural round-trip: ${structOk} compile cleanly, ${structBad} with errors`);
  console.log(`statement numbers kept: ${preserved}/${total}`);
  console.log(`after inserting 2 lines mid-program: ${editBad} fail to compile, ${editRenumbered} unchanged statements renumbered in total`);
  for (const s of samples) console.log(s);
  bridge.dispose();
  setTimeout(() => process.exit(0), 3500);
}
main().catch((e) => { console.error(e); bridge.dispose(); process.exit(1); });
