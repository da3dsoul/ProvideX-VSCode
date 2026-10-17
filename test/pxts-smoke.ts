import * as fs from 'fs';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';
import { fromPxts } from '../server/src/pxts/fromPxts';

const file = process.argv[2];
const from = Number(process.argv[3] ?? 0), count = Number(process.argv[4] ?? 60);
const numbered = fs.readFileSync(file, 'latin1').split(/\r?\n/).filter((l) => l.trim());
const view = toView(numbered.map((l) => l.replace(/^(\d+) LET /, '$1 ')));
const ts = toPxts(view.text).text;
console.log('===== .pxts =====');
console.log(ts.split('\n').slice(from, from + count).join('\n'));
const back = fromPxts(ts);
console.log('===== back to ProvideX =====');
console.log(back.text.split('\n').slice(from, from + count).join('\n'));
console.log('problems:', back.problems.slice(0, 10));

const modern = `function repeat$(s$, n) {
  let out$ = ""
  for (i = 1 to n) {
    out$ += s$
  }
  return out$
}

function find(limit) {
  let i, j
  for (i = 1 to 100) {
    for (j = 1 to 3) {
      if (i * i > limit) return i
    }
  }
  return -1
}

r$ = repeat$("ab", 3)  // ababab
r = find(7)
if (r == 3 && r$ != "") {
  print "ok"
} else if (r > 3) {
  print "big"
} else print "small"
`;
const m = fromPxts(modern);
console.log('===== modern -> ProvideX =====');
console.log(m.text);
console.log('problems:', m.problems);
console.log('===== and back to .pxts =====');
console.log(toPxts(m.text).text);
