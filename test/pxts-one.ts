// Debug helper: show where readable -> .pxts -> ProvideX differs for one corpus file.
import * as fs from 'fs';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
import { alignToBase } from '../server/src/pxts/align';
const text = fs.readFileSync(process.argv[2], 'latin1');
const view = toView(text.split(/\r?\n/).filter((l) => l.trim()));
const ts = toPxts(view.text).text;
const back = fromPxts(ts);
const a = view.text.split('\n').map((l) => l.trim()).filter(Boolean);
const b = alignToBase(back.text, view.text).text.split('\n').map((l) => l.trim()).filter(Boolean);
const norm = (s: string) => s.replace(/\bLET /gi, '').replace(/^REM/i, '!').replace(/\s+/g, '').toUpperCase();
let shown = 0;
for (let i = 0, j = 0; i < a.length && j < b.length && shown < Number(process.argv[3] ?? 5); i++, j++) {
  if (norm(a[i]) !== norm(b[j])) {
    shown++;
    console.log(`readable[${i}]: ${a[i]}\nback    [${j}]: ${b[j]}`);
    const tl = back.srcLine[back.text.split('\n').findIndex((l) => l.trim() === b[j])];
    console.log(`ts      [${tl}]: ${ts.split('\n')[tl]}\n`);
  }
}
for (const p of back.problems.slice(0, 5)) console.log('problem', p, '|', ts.split('\n')[p.line]);
if (process.argv[4]) {
  const { fromView } = require('../server/src/view');
  const numbered: string[] = fromView(back.text).numbered;
  const k = Number(process.argv[4]);
  console.log('numbered', k, ':', numbered[k]);
  const vl = fromView(back.text).viewLine[k];
  console.log('ts line', back.srcLine[vl], ':', ts.split('\n')[back.srcLine[vl]]);
}

{
  const again = toPxts(alignToBase(back.text, view.text).text).text.split('\n');
  const orig = ts.split('\n');
  const k = orig.findIndex((l, i) => l !== again[i]);
  console.log('exact', toPxts(alignToBase(back.text, view.text).text).text === ts);
  console.log('lines', orig.length, again.length, JSON.stringify(orig.slice(-2)), JSON.stringify(again.slice(-2)));
  console.log(k < 0 ? 'stable' : `unstable at ts line ${k}:\n  first : ${orig[k]}\n  second: ${again[k]}`);
}
