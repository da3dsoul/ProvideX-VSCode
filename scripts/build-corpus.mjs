// Decompiles compiled ProvideX programs under a directory into text files (a local test corpus).
// usage: node scripts/build-corpus.mjs <home> <srcDir> <outDir> [limit]
import fs from 'node:fs';
import path from 'node:path';
import { openBridge } from './bridge-client.mjs';

const [home, srcDir, outDir, limitArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 1e9);
fs.mkdirSync(outDir, { recursive: true });

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const isProgram = (p) => {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '[Pvxprg]';
  } catch { return false; }
};

const b = openBridge(home);
let n = 0, failed = 0;
for (const p of walk(srcDir)) {
  if (n >= limit) break;
  if (!isProgram(p)) continue;
  try {
    const r = await b.call('list', { path: p });
    const rel = path.relative(srcDir, p).replace(/[\\/]/g, '__');
    fs.writeFileSync(path.join(outDir, rel + '.pvx'), r.lines.map((l) => l.text).join('\r\n') + '\r\n', 'latin1');
    n++;
  } catch (e) { failed++; console.error('FAIL', p, e.message); }
}
console.log('decompiled', n, 'failed', failed);
b.close();
