// Smoke test for the COM bridge: node scripts/smoke-bridge.mjs [home]
import { openBridge } from './bridge-client.mjs';
import os from 'node:os';
import path from 'node:path';

const H = process.argv[2] ?? String.raw`E:\Sage 100\DEV\MAS90\Home`;
const b = openBridge(H);
const t = async (c, a) => {
  try { const r = await b.call(c, a); console.log(c, JSON.stringify(r).slice(0, 400)); return r; }
  catch (e) { console.log(c, 'ERR', e.message); }
};
const out = path.join(os.tmpdir(), 'pvx_smoke.pvc');
await t('check', { text: 'print "hi"\r\nx=1+\r\nfoo:\r\n  if x then print "a" else goto foo\r\nend', canonical: true });
await t('compile', { text: '0010 print "hi"\n0020 end', out });
await t('list', { path: out });
await t('dumpKeyed', { path: H + String.raw`\Lib\_lexdef.en`, max: 3 });
b.close();
