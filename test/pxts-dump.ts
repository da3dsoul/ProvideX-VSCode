import * as fs from 'fs';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
const text = fs.readFileSync(process.argv[2], 'latin1');
const view = toView(text.split(/\r?\n/).filter((l) => l.trim()));
const ts = toPxts(view.text).text;
const re = new RegExp(process.argv[3]);
ts.split('\n').forEach((l, i) => { if (re.test(l)) console.log(i, l); });
view.text.split('\n').forEach((l, i) => { if (re.test(l)) console.log('readable', i, l); });
