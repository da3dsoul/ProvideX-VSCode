// Debug helper: show the class header lines of readable vs readable -> TS -> ProvideX (aligned) for one file.
import * as fs from 'fs';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';
import { alignToBase } from '../server/src/pxts/align';
const text = fs.readFileSync(process.argv[2], 'latin1');
const view = toView(text.split(/\r?\n/).filter((l) => l.trim()));
const ts = toPxts(view.text).text;
const back = fromPxts(ts);
const al = alignToBase(back.text, view.text).text;
const from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? 40);
const show = (name: string, s: string) => { console.log('---- ' + name); s.split('\n').slice(from, to).forEach((l, i) => console.log(String(from + i).padStart(4), l)); };
show('readable', view.text);
show('back', back.text);
show('aligned', al);
if (process.argv[5]) show('ts', ts);
