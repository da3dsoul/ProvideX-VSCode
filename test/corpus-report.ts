// Parses every file in a corpus directory and summarises analyzer problems (to hunt false positives).
// build+run: npx esbuild test/corpus-report.ts --bundle --platform=node --outfile=out/corpus-report.js && node out/corpus-report.js <dir>
import * as fs from 'fs';
import * as path from 'path';
import { parse } from '../server/src/parser';
import { analyze } from '../server/src/analyzer';

const dir = process.argv[2];
const showSamples = Number(process.argv[3] ?? 3);
const files: string[] = [];
const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.pvx')) files.push(p); } };
walk(dir);
const counts = new Map<string, { n: number; samples: string[] }>();
let total = 0, lines = 0;
const t0 = Date.now();
for (const f of files) {
  const text = fs.readFileSync(f, 'latin1');
  const doc = parse(text);
  lines += doc.lines.length;
  const probs = analyze(doc, { undefinedLabels: true, unusedLabels: false, blockStructure: true });
  for (const p of probs) {
    total++;
    const key = `[${p.severity}] ${p.message.replace(/"[^"]*"|'[^']*'|\b[A-Z_][A-Za-z0-9_.]*[$%]?\b(?= )|\d+/g, '…')}`;
    const c = counts.get(key) ?? { n: 0, samples: [] };
    c.n++;
    if (c.samples.length < showSamples) c.samples.push(`${path.basename(f)}:${p.span.line + 1}: ${p.message} | ${doc.lines[p.span.line].slice(0, 160)}`);
    counts.set(key, c);
  }
}
console.log(`${files.length} files, ${lines} lines, ${total} problems, ${Date.now() - t0}ms`);
for (const [k, v] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`${v.n}\t${k}`);
  for (const s of v.samples) console.log('\t\t' + s);
}
