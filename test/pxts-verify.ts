// Verifies the .pxts translation against the real ProvideX (needs PVX_HOME).
//   npx esbuild test/pxts-verify.ts --bundle --platform=node --outfile=out/pxts-verify.js && node out/pxts-verify.js <corpusDir> [maxFiles]
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProvideXBridge } from '../server/src/bridge';
import { toView, fromView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
import { alignToBase } from '../server/src/pxts/align';

const home = process.env.PVX_HOME!;
const corpus = process.argv[2];
const maxFiles = Number(process.argv[3] ?? 200);
const bridge = new ProvideXBridge(path.join(__dirname, '..', 'bridge', 'pvxbridge.ps1'), () => home, () => undefined);
// "" and $$ are the same (empty) string
// "" and $$ are the same (empty) string; NEXT and NEXT var close the same loop; _OBJ is case-insensitive
const strip = (l: string) => l.replace(/^\d+[ ?]/, '').replace(/\s+$/, '').replace(/\$\$/g, '""').replace(/^NEXT \S+$/, 'NEXT').replace(/\b_obj\b/gi, '_OBJ');

async function runtime() {
  const cases: { name: string; src: string; expr: string; want: string }[] = [
    { name: 'string function with locals', expr: 'R$', want: 'ababab', src: 'function repeat$(s$, n) {\n  let out$ = "", i\n  for (i = 1 to n) out$ += s$\n  return out$\n}\nR$ = repeat$("ab", 3)\nend' },
    { name: 'return from nested loops', expr: 'STR(R)', want: '3', src: 'function find(limit) {\n  let i, j\n  for (i = 1 to 100) {\n    for (j = 1 to 3) {\n      if (i * i > limit) return i\n    }\n  }\n  return -1\n}\nR = find(7)\nend' },
    { name: 'recursion keeps locals', expr: 'STR(R)', want: '55', src: 'function fib(n) {\n  let a, b\n  if (n < 2) return n\n  a = fib(n - 1)\n  b = fib(n - 2)\n  return a + b\n}\nR = fib(10)\nend' },
    { name: 'caller variables untouched', expr: 'STR(n)+","+STR(R)', want: '100,10', src: 'function twice(n) {\n  return n * 2\n}\nn = 100\nR = twice(5)\nend' },
    { name: 'return inside switch in loop', expr: 'STR(R)', want: '20', src: 'function pick(x) {\n  let i\n  for (i = 1 to 5) {\n    switch (i) {\n      case 2:\n        if (x == 2) return 20\n        break\n      default:\n    }\n  }\n  return 0\n}\nR = pick(2)\nend' },
    { name: 'if / else if / else, && || !', expr: 'R$', want: 'bc', src: 'x = 2; R$ = ""\nif (x == 1) {\n  R$ = "a"\n} else if (x == 2 && !(x > 5)) {\n  R$ = "b"\n} else R$ = "z"\nif (x != 2 || x == 2) R$ += "c"\nend' },
    { name: 'while / repeat / select-free loops', expr: 'R$', want: '3,2,1,0 4', src: 'n = 3; R$ = ""\nwhile (n >= 0) {\n  R$ += str(n)\n  if (n > 0) R$ += ","\n  n--\n}\nk = 0\nrepeat {\n  k++\n} until (k > 3)\nR$ += " " + str(k)\nend' },
    { name: 'escapes and dotted names', expr: 'STR(LEN(R$))+rec.name$', want: '4bob', src: 'rec::name$ = "bob"\nR$ = "a\\r\\nb"\nend' },
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxts-rt-'));
  let fail = 0;
  for (const [i, c] of cases.entries()) {
    const pvx = fromPxts(c.src);
    const numbered = fromView(pvx.text).numbered;
    const out = path.join(tmp, `c${i}.pvc`);
    const r = await bridge.compile(numbered.join('\n'), out);
    let got = 'COMPILE FAILED ' + JSON.stringify(r.diagnostics.map((d) => numbered[d.line]));
    if (r.saved) {
      await bridge.call('exec', { command: `LOAD "${out}"` });
      try { await bridge.call('exec', { command: 'RUN' }); } catch { /* END */ }
      got = await bridge.evaluate(c.expr);
    }
    const ok = got === c.want;
    if (!ok) fail++;
    console.log(`runtime ${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${got}${ok ? '' : ' (want ' + c.want + ')'}`);
    if (!ok || process.env.SHOW) console.log(pvx.text.split('\n').map((l) => '      | ' + l).join('\n'));
    // TS -> PVX -> TS is stable
    const again = toPxts(pvx.text).text;
    const norm = (s: string) => s.split('\n').map((l) => l.replace(/\s+/g, '')).filter(Boolean).join('\n');
    if (norm(fromPxts(again).text) !== norm(pvx.text)) { console.log('   not stable:\n' + fromPxts(again).text); fail++; }
  }
  return fail;
}

async function main() {
  await bridge.info();
  const rtFail = await runtime();
  const files = (fs.readdirSync(corpus, { recursive: true } as never) as string[]).map(String).filter((f) => f.endsWith('.pvx')).slice(0, maxFiles);
  let same = 0, diff = 0, raw = 0, rawLines = 0, problems = 0, stable = 0, total = 0;
  const samples: string[] = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(corpus, rel), 'latin1');
    if (text.split('\n').some((l) => /^\d+\?/.test(l))) continue;
    total++;
    const view = toView(text.split(/\r?\n/).filter((l) => l.trim()));
    const ts = toPxts(view.text).text;
    const back = fromPxts(ts);
    problems += back.problems.filter((x) => x.severity !== 'warning').length;
    for (const pr of back.problems.filter((x) => x.severity !== 'warning').slice(0, 2)) if (samples.length < 40) samples.push(`${rel}:${pr.line + 1}: translator: ${pr.message} | ${ts.split('\n')[pr.line]}`);
    const rawCount = (ts.match(/pvx`/g) ?? []).length;
    rawLines += rawCount;
    if (rawCount) raw++;
    const aligned = alignToBase(back.text, view.text).text;
    if (toPxts(aligned).text === ts) stable++;
    const a = await bridge.check(fromView(view.text).numbered.join('\n'), true);
    const b = await bridge.check(fromView(aligned).numbered.join('\n'), true);
    const A = a.canonical.map((c) => strip(c.text)), B = b.canonical.map((c) => strip(c.text));
    const eq = A.length === B.length && A.every((x, k) => x === B[k]) && b.diagnostics.length <= a.diagnostics.length;
    if (eq) same++;
    else {
      diff++;
      if (samples.length < 20) {
        const k = A.findIndex((x, j) => x !== B[j]);
        samples.push(`${rel}: ${b.diagnostics.length > a.diagnostics.length ? 'compile errors ' + JSON.stringify(b.diagnostics.slice(0, 1)) : ''}\n   readable: ${A[k]}\n   via TS  : ${B[k]}`);
      }
    }
  }
  console.log(`\nruntime: ${rtFail ? rtFail + ' FAILED' : 'all ok'}`);
  console.log(`corpus: ${same}/${total} identical after readable -> TS -> ProvideX (${diff} different)`);
  console.log(`translator problems: ${problems}; TS->PVX->TS stable: ${stable}/${total}; files using pvx\`...\`: ${raw} (${rawLines} statements)`);
  for (const s of samples) console.log(s);
  console.log(`\nSUMMARY runtime ${rtFail ? rtFail + ' FAILED' : 'all ok'}; corpus identical ${same}/${total}; problems ${problems}; stable ${stable}/${total}; raw statements ${rawLines}`);
  bridge.dispose();
  setTimeout(() => process.exit(0), 3500);
}
main().catch((e) => { console.error(e); bridge.dispose(); process.exit(1); });



