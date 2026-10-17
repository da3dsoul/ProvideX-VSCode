import * as fs from 'fs';
import { toView, defaultViewOptions } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
const lines = fs.readFileSync(process.argv[2], 'latin1').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.replace(/^(\d+ )LET /, '$1').replace(/; LET /g, '; '));
const view = toView(lines, defaultViewOptions);
console.log(toPxts(view.text).text.split('\n').slice(Number(process.argv[3] ?? 0), Number(process.argv[4] ?? 200)).join('\n'));
