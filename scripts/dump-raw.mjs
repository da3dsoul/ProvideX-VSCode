// Dumps raw ProvideX lexicon/parameter/message tables from an installed ProvideX via the COM bridge.
// usage: set PVX_HOME=<ProvideX home dir>  then  node scripts/dump-raw.mjs <outdir>
import fs from 'node:fs';
import path from 'node:path';
import { openBridge } from './bridge-client.mjs';

const home = process.env.PVX_HOME;
const out = process.argv[2] ?? 'raw';
if (!home) { console.error('Set PVX_HOME to the ProvideX home folder (the one containing pvxwin32.exe and Lib)'); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const b = openBridge(home);
const info = await b.call('init', { home });
console.log('ProvideX', info);
for (const f of ['_lexdef.en', '_prmdef.en']) {
  const r = await b.call('dumpKeyed', { path: path.join(home, 'Lib', f) });
  fs.writeFileSync(path.join(out, f + '.json'), JSON.stringify(r.records, null, 1));
  console.log(f, r.records.length);
}
const msgs = await b.call('messages');
fs.writeFileSync(path.join(out, 'messages.json'), JSON.stringify(msgs, null, 1));
b.close();
