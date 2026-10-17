// Builds data/lexicon.json, data/messages.json and data/params.json from raw dumps produced by dump-raw.mjs.
// The raw tables come from the installed ProvideX (Lib/_lexdef.en, Lib/_prmdef.en and MSG()).
// usage: node scripts/build-lexicon.mjs <rawdir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv[2] ?? 'raw';
const dec = (h) => Buffer.from(h, 'hex').toString('latin1');

// ---- lexicon ----
const recs = JSON.parse(fs.readFileSync(path.join(raw, '_lexdef.en.json'), 'utf8'));
const rows = recs.map((r) => {
  const f = dec(r.hex).split('\x8a');
  return { key: dec(r.key), code: f[0].toUpperCase(), flags: parseInt(f[1], 16), text: f[2] };
});

const lex = { directives: [], functions: [], systemVariables: [], mnemonics: [], fileOptions: [], operators: [], aliases: {} };
const add = (arr, v) => { if (!arr.includes(v)) arr.push(v); };
for (const r of rows) {
  const t = r.text.trim();
  if (r.flags === 0x9b) continue; // misspelling aliases accepted by the command line (LAOD, LSIT ...)
  if (/^'.+'\s*\(?$/.test(t)) { add(lex.mnemonics, t.replace(/\s*\($/, '').replace(/^'|'$/g, '')); continue; }
  if (/^,[A-Z]{3}=$/.test(t) || /^[A-Z]{3}=$/.test(t)) { add(lex.fileOptions, t.replace(/^,/, '').replace(/=$/, '')); continue; }
  if (/^[A-Z][A-Z0-9_]*\s*\($/.test(t)) { add(lex.functions, t.replace(/\s*\($/, '')); continue; }
  if (r.flags === 0x08) { add(lex.systemVariables, t); continue; }
  if (/^[A-Z][A-Z0-9_ ]*$/.test(t)) {
    if (r.flags === 0x00) { add(lex.systemVariables, t); continue; } // HLP, OBJ
    add(lex.directives, t);
    continue;
  }
  add(lex.operators, t);
}
// alternate spellings (flag 0x80) map onto the primary token with the same code
const byCode = new Map();
for (const r of rows) if (!(r.flags & 0x80) && r.flags !== 0x9b) byCode.set(r.code, r.text.trim());
for (const r of rows) if (r.flags & 0x80 && byCode.has(r.code)) lex.aliases[r.text.trim().replace(/\s*\($/, '')] = byCode.get(r.code).replace(/\s*\($/, '');
for (const k of Object.keys(lex)) if (Array.isArray(lex[k])) lex[k].sort();
lex.source = 'Extracted from ProvideX Lib/_lexdef.en via the ProvideX.Script COM server';
fs.writeFileSync(path.join(root, 'data', 'lexicon.json'), JSON.stringify(lex, null, 1));
console.log(Object.fromEntries(Object.entries(lex).map(([k, v]) => [k, Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : v])));

// ---- error messages ----
const msgs = JSON.parse(fs.readFileSync(path.join(raw, 'messages.json'), 'utf8'));
const errors = {};
for (const [n, m] of Object.entries(msgs)) {
  const mm = /^(Error|Warning) #(\d+): (.*)$/.exec(m.trim());
  if (mm) errors[mm[2]] = { kind: mm[1].toLowerCase(), text: mm[3].trim() };
}
fs.writeFileSync(path.join(root, 'data', 'errors.json'), JSON.stringify(errors, null, 1));
console.log('errors', Object.keys(errors).length);

// ---- system parameters ----
const prm = JSON.parse(fs.readFileSync(path.join(raw, '_prmdef.en.json'), 'utf8'));
const params = {};
for (const r of prm) {
  const key = dec(r.key).trim();
  const f = dec(r.hex).split('\x8a');
  const [title, min, max, def, flag, ...rest] = f;
  const doc = rest.join(' ').replace(/\s+/g, ' ').trim();
  params[key] = { title: title.trim(), min: min || undefined, max: max || undefined, default: def || undefined, onOff: !min && !max, doc };
}
fs.writeFileSync(path.join(root, 'data', 'params.json'), JSON.stringify(params, null, 1));
console.log('params', Object.keys(params).length);
