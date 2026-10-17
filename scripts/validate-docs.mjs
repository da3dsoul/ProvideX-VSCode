// Validate data/docs/*.json against the real ProvideX syntax checker (via the COM bridge).
//   node scripts/validate-docs.mjs [--home <ProvideX home>] [--no-write]
// Writes validation results back into data/docs/functions.json ("validation" field per function)
// and a summary to data/docs/VALIDATION.md.
import { openBridge } from './bridge-client.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'data', 'docs');
const argv = process.argv.slice(2);
const HOME = argv.includes('--home') ? argv[argv.indexOf('--home') + 1] : String.raw`E:\Sage 100\DEV\MAS90\Home`;
const WRITE = !argv.includes('--no-write');
const load = (f) => JSON.parse(fs.readFileSync(path.join(docs, f), 'utf8'));
const lexicon = JSON.parse(fs.readFileSync(path.join(root, 'data', 'lexicon.json'), 'utf8'));
const functions = load('functions.json');
const directives = load('directives.json');
const sysvars = load('sysvars.json');
const options = load('options.json');
const mnemonics = load('mnemonics.json');
const params = load('params.json');

// ---------- test-case collection ----------
const cases = []; // { group, key, label, text, expect: 'ok'|'err' }
const add = (group, key, label, text, expect = 'ok') => cases.push({ group, key, label, text, expect });

// dummy argument for a documented parameter
function dummy(p) {
  const n = p.name;
  if (n.startsWith("'")) return "'BY'";
  if (n.includes('=')) return '"a"="abc"';
  if (n === 'stmtref') return '100';
  return /\$$/.test(n) ? '"a"' : '1';
}
const target = (ret) => (ret === 'string' ? 'X$' : 'X');
const other = (ret) => (ret === 'string' ? 'X' : 'X$');

for (const [name, fn] of Object.entries(functions)) {
  fn.signatures.forEach((sig, si) => {
    const ret = sig.returns ?? fn.returns;
    const ps = sig.params;
    const lastP = ps[ps.length - 1];
    const argsFor = (n) => {
      const a = [];
      for (let i = 0; i < n; i++) a.push(dummy(ps[Math.min(i, ps.length - 1)] ?? { name: 'x' }));
      return a.join(',');
    };
    const max = sig.maxArgs ?? sig.minArgs + 3;
    const t = ret === 'any' ? null : target(ret);
    const call = (n) => `${name}(${argsFor(n)})`;
    const k = `${name}#${si}`;
    if (t) {
      add('fn', k, 'min', `${t}=${call(sig.minArgs)}`);
      add('fn', k, 'max', `${t}=${call(max)}`);
      add('fn', k, 'extra', `${t}=${call(max + 1)}`, sig.maxArgs == null ? 'ok' : 'err');
      if (sig.minArgs > 0) add('fn', k, 'fewer', `${t}=${call(sig.minArgs - 1)}`, 'err');
      add('fn', k, 'wrongType', `${other(ret)}=${call(sig.minArgs)}`, 'err');
      if (sig.label.includes(':')) add('fn', k, 'colon', `${t}=${name}(${argsFor(sig.minArgs)}:"%Y")`.replace('"%Y")', name === 'STR' ? '"##0.00")' : '"%Y")'));
      for (const o of fn.options ?? []) {
        const v = o === 'KEY' || o === 'SEP' ? '"a"' : '100';
        add('fn', k, `opt:${o}`, `${t}=${name}(${argsFor(sig.minArgs)},${o}=${v})`);
      }
    } else {
      // returns any: at least one of X / X$ must accept
      add('fn', k, 'min:any', `X=${call(sig.minArgs)}`, 'any');
      add('fn', k, 'min:any$', `X$=${call(sig.minArgs)}`, 'any');
    }
  });
}

// ---------- directives: simplest forms ----------
const D = {
  ACCEPT: 'ACCEPT (0)A$', ADDR: 'ADDR "PROG"', AUTO: null, BEGIN: 'BEGIN', BREAK: ['FOR I=1 TO 2', 'BREAK', 'NEXT I'],
  BUTTON: 'BUTTON 100,@(1,1,10,2)="OK"', CALL: 'CALL "PROG",A$', CHECK_BOX: 'CHECK_BOX 101,@(1,3,10,1)="Chk"',
  CLEAR: 'CLEAR', CLIP_BOARD: 'CLIP_BOARD READ A$', CLOSE: 'CLOSE (1)', CONTINUE: ['WHILE 1', 'CONTINUE', 'WEND'],
  CWDIR: 'CWDIR "C:\\"', DATA: 'DATA 1,"a"', DAY_FORMAT: 'DAY_FORMAT "MM/DD/YY"', DEF: 'DEF FNA(X)=X*2',
  DELETE: 'DELETE OBJECT X', DIM: 'DIM A$[10],B[5],C$(20)', DIRECT: 'DIRECT "F",10,100,50', DIRECTORY: 'DIRECTORY "C:\\TMP\\X"',
  DROP: 'DROP "PROG"', DROP_BOX: 'DROP_BOX 102,@(1,5,20,5)', DUMP: 'DUMP', END: 'END', ENDTRACE: 'ENDTRACE',
  ENTER: 'ENTER A$,B', ERASE: 'ERASE "F"', ERROR_HANDLER: 'ERROR_HANDLER "PROG"', ESCAPE: 'ESCAPE', EXECUTE: 'EXECUTE "X=1"',
  EXIT: 'EXIT', EXITTO: 'EXITTO 100', EXTRACT: 'EXTRACT (1,KEY="A")A$', FIND: 'FIND (1,KEY="A",DOM=*NEXT)A$',
  FLOATINGPOINT: 'FLOATINGPOINT', FOR: ['FOR I=1 TO 10 STEP 2', 'NEXT I'], FUNCTION: null, GET_FILE_BOX: 'GET_FILE_BOX A$,"C:\\","Open"',
  GOSUB: 'GOSUB 100', GOTO: 'GOTO 100', GRID: 'GRID 103,@(1,1,40,10)', IF: 'IF X THEN PRINT "Y" ELSE PRINT "N"',
  END_IF: 'IF X THEN PRINT "Y" ELSE PRINT "N" END_IF; PRINT "always"', 'IF braces': ['IF X THEN {', 'PRINT "Y"', '} ELSE {', 'PRINT "N"', '}'], INDEXED: 'INDEXED "F",100,50', INPUT: 'INPUT "Name: ",A$',
  INVOKE: 'INVOKE "notepad.exe"', IOLIST: 'IOLIST A$,B', KEYED: 'KEYED "F",10,100,50', LET: 'LET X=1', LIST: null,
  LIST_BOX: 'LIST_BOX 104,@(1,1,20,5)', LOAD: null, LOCAL: 'LOCAL X,Y$', LOCK: 'LOCK (1)', LONG_FORM: null, MENU_BAR: 'MENU_BAR 105,"&File"',
  MERGE: null, MESSAGE_LIB: 'MESSAGE_LIB "*MSG"', MNEMONIC: "MNEMONIC (1)'XX'=$1B$", MSGBOX: 'MSGBOX "Hi","Title"',
  MULTI_LINE: 'MULTI_LINE 106,@(1,1,20,1)', NEXT: ['FOR I=1 TO 2', 'NEXT'], OBTAIN: 'OBTAIN A$', ON: 'ON X GOTO 100,200',
  OPEN: 'OPEN (1,ERR=*NEXT)"F"', PASSWORD: null, PERFORM: 'PERFORM "PROG"', POP: 'POP', POPUP_MENU: null, PRECISION: 'PRECISION 4',
  PREFIX: 'PREFIX "C:\\"', PREINPUT: 'PREINPUT "a"', PRINT: "PRINT 'CS',@(1,2),\"Hi\",X:\"##0.00\"", PROCESS: 'PROCESS "PNL","LIB"',
  PROGRAM: 'PROGRAM "P"', PURGE: 'PURGE (1)', QUIT: 'QUIT', RANDOMIZE: 'RANDOMIZE 5',
  READ: 'READ (1,KEY="A",DOM=*NEXT,END=*NEXT)A$,B', READDATA: 'READ DATA A$', RECORD: 'READ RECORD (1)A$', REDIM: 'REDIM A$[20]',
  RELEASE: 'RELEASE', REM: 'REM comment', REMOVE: 'REMOVE (1,KEY="A")', RENAME: 'RENAME "A" TO "B"', RENUMBER: null,
  REPEAT: ['REPEAT', 'UNTIL X'], RESET: 'RESET', RESTORE: 'RESTORE', RETRY: 'RETRY', RETURN: 'RETURN', RUN: 'RUN "PROG"',
  SAVE: null, SELECT: ['SELECT A$ FROM "F" BEGIN "A" END "Z" WHERE A$>""', 'NEXT RECORD'], SERIAL: 'SERIAL "F"',
  SETDAY: 'SETDAY "01/01/20"', SETERR: 'SETERR 100', SETESC: 'SETESC 100', SETTIME: 'SETTIME 12', SETTRACE: 'SETTRACE',
  SET_FOCUS: 'SET_FOCUS 100', SET_PARAM: "SET_PARAM 'BY'=1970", SHORT_FORM: null, SORT: 'SORT "F",10,100', STOP: 'STOP',
  SWITCH: ['SWITCH X', 'CASE 1,2', 'PRINT "a"', 'BREAK', 'DEFAULT', 'PRINT "b"', 'END SWITCH'], SWAP: 'SWAP (1)',
  SYSTEM_HELP: 'SYSTEM_HELP "x.hlp"', TABLE: 'TABLE 000102030405', TRY: ['TRY', 'X=1', 'CATCH', 'X=2', 'END_TRY'],
  TRISTATE_BOX: 'TRISTATE_BOX 108,@(1,1,10,1)="T"', UNLOCK: 'UNLOCK (1)', WAIT: 'WAIT 1', WHILE: ['WHILE X<10', 'X=X+1', 'WEND'],
  WRITE: 'WRITE (1,KEY="A")A$,B', 'V_SCROLLBAR': 'V_SCROLLBAR 109,@(1,1,1,10)', 'H_SCROLLBAR': 'H_SCROLLBAR 110,@(1,1,10,1)',
  'DEF CLASS': ['DEF CLASS "Foo"', 'PROPERTY Name$', 'PROPERTY Count GET GetCount SET ERR', 'FUNCTION Hello$()', 'FUNCTION LOCAL Helper(X)', 'END DEF'],
  'DEF FN': ['DEF FNTWICE(X)', 'RETURN X*2', 'END DEF'], 'END DEF': ['DEF FNT(X)', 'RETURN X', 'END DEF'],
  CHART: 'CHART 111,@(1,1,20,10)', 'DEF OBJECT': 'DEF OBJECT X,"Shell.Application"', LIKE: ['DEF CLASS "A"', 'LIKE "B"', 'END DEF'], 'NEXT RECORD': ['SELECT A$ FROM "F"', 'NEXT RECORD'], FINALLY: ['TRY', 'X=1', 'CATCH', 'X=2', 'FINALLY', 'X=3', 'END_TRY'],
  'ON GOSUB': 'ON X GOSUB 100,200', 'IF block braces': 'IF X THEN { PRINT "Y" } ELSE { PRINT "N" }', 'FOR chan': 'FOR (1)',
  'ADD': 'ADD "x"', 'AUTO_LOCK': 'AUTO_LOCK ON', 'SETDEV': 'SETDEV (1) "a"',
  'SECURITY_MASK': 'SECURITY_MASK READ A$', 'SYSTEM_JRNL': 'SYSTEM_JRNL CLOSE', 'VIDEO_PALETTE': 'VIDEO_PALETTE "a"', 'WINPRT_SETUP': 'WINPRT_SETUP READ A$',
  'STATIC': 'STATIC X', 'REFILE': 'REFILE "F"', 'SETMOUSE': 'SETMOUSE ON', 'SETFID': 'SETFID "x"', 'SETDRIVE': 'SETDRIVE "C:"',
  'CUSTOM_VBX': 'CUSTOM_VBX REMOVE 112', 'VARDROP_BOX': 'VARDROP_BOX 113,@(1,1,10,5)', 'VARLIST_BOX': 'VARLIST_BOX 114,@(1,1,10,5)',
  'MULTI_MEDIA': 'MULTI_MEDIA "x"', 'LINE_SWITCH': 'LINE_SWITCH 0', 'SET_NBF': 'SET_NBF 0', 'TRANSLATE': 'TRANSLATE A$,B$', 'DEFPRT': 'DEFPRT 1,2', 'DEFTTY': 'DEFTTY 1,2',
  'ENABLE': 'ENABLE CONTROL 100', 'DISABLE': 'DISABLE CONTROL 100', 'HIDE': 'HIDE CONTROL 100', 'SHOW': 'SHOW CONTROL 100',
  'INSERT': 'INSERT 0', 'UPDATE': 'UPDATE 0', 'FILE': 'FILE "x"',
};
for (const [k, v] of Object.entries(D)) {
  if (v == null) continue;
  const lines = Array.isArray(v) ? v : [v];
  add('dir', k, 'form', lines.join('\r\n'));
}

// ---------- options *specials ----------
for (const s of Object.keys(options['*specials'] ?? {})) add('special', s, 'ERR=', `READ (1,ERR=${s})A$`);
for (const s of Object.keys(options['*specials'] ?? {})) add('special', s, 'END=', `READ (1,END=${s})A$`);
for (const o of Object.keys(options).filter((k) => !k.startsWith('*'))) {
  const v = ['KEY', 'SEP', 'OPT', 'NUL', 'TIP', 'MSG', 'HLP', 'FNT'].includes(o) ? '"a"' : '100';
  add('opt', o, 'READ', `READ (1,${o}=${v})A$`, 'any');
  add('opt', o, 'OPEN', `OPEN (1,${o}=${v})"F"`, 'any');
  add('opt', o, 'INPUT', `INPUT (0,${o}=${v})A$`, 'any');
}
// ---------- sysvars ----------
for (const [k, v] of Object.entries(sysvars)) {
  if (k === '%' || k === 'FN') continue;
  if (v.returns === 'any') continue;
  add('sysvar', k, 'read', `${target(v.returns)}=${k}`);
  add('sysvar', k, 'wrongType', `${other(v.returns)}=${k}`, 'err');
}
add('sysvar', '%', 'global', 'X$=%NAME$');
add('sysvar', '$$', 'null-literal', 'X$=$$');
// ---------- mnemonics / params ----------
for (const [k, m] of Object.entries(mnemonics).filter(([k]) => !k.startsWith('*'))) {
  if (m.argFormUnconfirmed) add('mnem', k, 'print', `PRINT '${k}'`, 'any');
  else add('mnem', k, 'print', `PRINT ${m.example ?? `'${k}'`}`);
}
add('mnem', 'QZ', 'bogus', "PRINT 'QZ'", 'any');
for (const k of Object.keys(params)) add('param', k, 'set', `SET_PARAM '${k}'`);
add('param', 'Q9', 'bogus', "SET_PARAM 'Q9'", 'any');
add('param', 'BY', 'prm()', "X=PRM('BY')");

// ---------- run ----------
const b = openBridge(HOME);
const results = [];
try {
  let batch = [], meta = [];
  const flush = async () => {
    if (!batch.length) return;
    const r = await b.call('check', { text: batch.join('\r\n'), canonical: true });
    const bad = new Map(r.diagnostics.map((d) => [d.line, d]));
    const can = new Map((r.canonical ?? []).map((c) => [c.line, c.text]));
    for (const m of meta) {
      const errs = [];
      const canon = [];
      for (let l = m.start; l < m.start + m.n; l++) { if (bad.has(l)) errs.push(bad.get(l)); canon.push(can.get(l)); }
      results.push({ ...m.c, ok: errs.length === 0, errs, canon });
    }
    batch = []; meta = [];
  };
  for (const c of cases) {
    const lines = c.text.split('\r\n');
    meta.push({ c, start: batch.length, n: lines.length });
    batch.push(...lines);
    if (batch.length > 1500) await flush();
  }
  await flush();
} finally { b.close(); }

// ---------- evaluate ----------
const pass = (r) => (r.expect === 'ok' ? r.ok : r.expect === 'err' ? !r.ok : true);
const by = (g) => results.filter((r) => r.group === g);

// functions: per function summary
const fnRes = {};
for (const r of by('fn')) {
  const [name, si] = r.key.split('#');
  ((fnRes[name] ??= {})[si] ??= {})[r.label] = r.ok;
}
const fnSummary = { confirmed: [], arityProblems: [], returnProblems: [], extraNotRejected: [], optionProblems: [], notAccepted: [] };
for (const [name, fn] of Object.entries(functions)) {
  const sigs = fnRes[name] ?? {};
  const v = { signatures: [] };
  let allOk = true;
  fn.signatures.forEach((sig, si) => {
    const t = sigs[si] ?? {};
    const sv = {};
    if ('min:any' in t) {
      sv.accepted = t['min:any'] || t['min:any$'];
      sv.returns = t['min:any'] && t['min:any$'] ? 'any' : t['min:any'] ? 'number' : t['min:any$'] ? 'string' : null;
      if (!sv.accepted) { allOk = false; fnSummary.notAccepted.push(name); }
    } else {
      sv.minArgs = t.min; sv.maxArgs = t.max;
      if ('extra' in t) sv.extraArgRejected = sig.maxArgs == null ? null : !t.extra;
      if ('fewer' in t) sv.fewerArgRejected = !t.fewer;
      sv.returnTypeChecked = t.wrongType === false;
      if ('colon' in t) sv.colonForm = t.colon;
      const opts = Object.entries(t).filter(([k]) => k.startsWith('opt:'));
      if (opts.length) sv.options = Object.fromEntries(opts.map(([k, x]) => [k.slice(4), x]));
      if (!t.min || !t.max) { allOk = false; fnSummary.arityProblems.push(`${sig.label}${!t.min ? ' (min form rejected)' : ''}${!t.max ? ' (max form rejected)' : ''}`); }
      if (t.wrongType) fnSummary.returnProblems.push(sig.label);
      if (sig.maxArgs != null && t.extra) fnSummary.extraNotRejected.push(sig.label);
      for (const [o, x] of opts) if (!x) fnSummary.optionProblems.push(`${name} ${o.slice(4)}=`);
    }
    v.signatures.push(sv);
  });
  v.confirmed = allOk;
  if (allOk) fnSummary.confirmed.push(name);
  fn.validation = v;
}

if (WRITE) fs.writeFileSync(path.join(docs, 'functions.json'), JSON.stringify(functions, null, 2) + '\n');

const fail = (g) => by(g).filter((r) => !pass(r));
const keysOk = (g) => [...new Set(by(g).filter(pass).map((r) => r.key))];
const md = [];
md.push('# Documentation validation against ProvideX 9.62', '');
md.push(`Generated by \`scripts/validate-docs.mjs\` on ${new Date().toISOString().slice(0, 10)} using the ProvideX syntax checker through the COM bridge (\`bridge/pvxbridge.ps1\`, home \`${HOME}\`).`, '');
md.push('The checker compiles each test statement; it does **not** execute it. Function arity and return types are enforced at compile time for fixed-arity functions, so "min/max accepted, max+1 rejected, wrong target type rejected" is a strong confirmation of a signature.', '');
md.push('## Functions', '');
md.push(`- Functions documented: ${Object.keys(functions).length} (lexicon: ${lexicon.functions.length}); all lexicon names covered: ${lexicon.functions.every((f) => functions[f]) ? 'yes' : 'NO'}`);
md.push(`- Signatures fully accepted (min and max arg forms compile): ${fnSummary.confirmed.length} functions`);
md.push(`- Test statements: ${by('fn').length}, matching expectation: ${by('fn').filter(pass).length}`);
md.push('- A scan of all 3-character names (A-Z, 0-9) for function-like behaviour found no functions missing from the lexicon (only user FNx functions), so no extra functions were added.', '');
md.push('### Not accepted by the checker in any tested form', '', ...(fnSummary.notAccepted.length ? fnSummary.notAccepted.map((x) => `- ${x}`) : ['- none']), '');
md.push('### Arity forms rejected (documented signature does not compile)', '', ...(fnSummary.arityProblems.length ? fnSummary.arityProblems.map((x) => `- \`${x}\``) : ['- none']), '');
md.push('### Return type not enforced (assignment to the other type also compiled)', '', ...(fnSummary.returnProblems.length ? fnSummary.returnProblems.map((x) => `- \`${x}\``) : ['- none']), '');
md.push('### Extra argument (maxArgs+1) NOT rejected at compile time', '', 'For these the checker accepts additional arguments, so the documented maximum is based on documentation/runtime tests rather than on the compiler:', '', ...(fnSummary.extraNotRejected.length ? fnSummary.extraNotRejected.map((x) => `- \`${x}\``) : ['- none']), '');
md.push('### File options rejected', '', ...(fnSummary.optionProblems.length ? fnSummary.optionProblems.map((x) => `- ${x}`) : ['- none']), '');
const unv = Object.entries(functions).filter(([, f]) => f.unverified || f.signatures.some((s) => s.unverified)).map(([k]) => k);
md.push('### Semantics not confirmed (marked `unverified`)', '', 'Arity/return type of these were checked by the compiler, but their meaning could not be confirmed (runtime probing via `eval` was inconclusive):', '', unv.join(', '), '');
md.push('### Runtime spot checks', '', 'Semantics were additionally spot-checked by evaluating expressions in the live session with the bridge `eval` command (`scripts/probe-eval.mjs`), e.g.: EXP/LOG are base 10 (EXP(1)=10); HSH types 1/2/3/4 = MD5/MD4/MD2/SHA-1; CVS codes 1/2/4/8/16/32/256; JST/PAD modes 0 right, 1 left, 2 centre; STP modes 0/1/2/3; SWP modes; POS step<0 searches backwards and occurrence 0 returns the count; GAP/GEP odd/even parity; TBL index and translate forms; VIN/VIS read variables by name; CMP/UCP and CPL/LST round-trip; DTE format codes; MOD sign; NUL true for all-space strings. Functions reading channel 0 (KEY, RCD, IND, RNO ...) were not executed because they block waiting for terminal input.', '');
md.push('## Directives', '');
const dirFails = fail('dir');
md.push(`- Directive entries documented: ${Object.keys(directives).length} (lexicon: ${lexicon.directives.length}); all lexicon names covered: ${lexicon.directives.every((d) => directives[d]) ? 'yes' : 'NO (' + lexicon.directives.filter((d) => !directives[d]).join(', ') + ')'}`);
md.push(`- Sample statements checked: ${by('dir').length}; compiled cleanly: ${by('dir').filter(pass).length}`, '');
md.push('### Sample forms that did not compile', '', ...(dirFails.length ? dirFails.map((r) => `- **${r.key}**: \`${r.text.replace(/\r\n/g, ' / ')}\` (error line(s): ${r.errs.map((e) => e.text ?? e.line).join('; ')})`) : ['- none']), '');
md.push('### Lexicon directives with no compiling form found', '', 'Probing ~17 generic argument shapes (none, number, string, (chan), lists, ON/OFF, READ var$, control definitions) found no accepted statement for these; their documented syntax is marked `unverified` (PROCEED, EVENT, PROPERTIES and CONTROL appear to be clause keywords only):', '', '- RADIO_BUTTON, DEFCTL, SETCTL, USER_LEX, PROCEED (only as *PROCEED), EVENT, PROPERTIES, CONTROL (only after ENABLE/DISABLE/HIDE/SHOW)', '', 'Other forms found NOT to compile in 9.62 (docs adjusted): multi-line `IF ... THEN` / `END_IF` without braces (END_IF only terminates a single-line IF), `RANDOMIZE` without a seed, arrays with parentheses in DIM/REDIM (arrays use `[ ]`; `DIM A$(n)` sizes a string), `SWAP a,b`, `FOR v$="a","b"`, `CASE a TO b`, `PROPERTY LOCAL/HIDE`, `FUNCTION HIDE`, `FUNCTION ... FOR PROGRAM`, `DEF CLASS ... FOR PROGRAM`, `PRECISION n FOR PROGRAM`, `CLEAR {ALL}`, `LIST_BOX FIND`, `BUTTON WRITE`, `MENU_BAR REMOVE`, `PASSWORD ... ENCRYPT`, `READ (chan,ERR=*EXIT)`.', '');
md.push('## Options', '');
md.push(`- *special branch targets accepted (ERR=/END=): ${keysOk('special').join(', ') || 'none'}`);
md.push(`- *special targets rejected: ${[...new Set(fail('special').map((r) => r.key))].join(', ') || 'none'}`);
const optAcc = {};
for (const r of by('opt')) (optAcc[r.key] ??= []).push(r.ok ? r.label : null);
md.push('- File options accepted by the compiler on READ / OPEN / INPUT:', '');
md.push('| Option | READ | OPEN | INPUT |', '|---|---|---|---|');
for (const [k] of Object.entries(optAcc)) {
  const g = (l) => (by('opt').find((r) => r.key === k && r.label === l)?.ok ? 'yes' : 'no');
  md.push(`| ${k} | ${g('READ')} | ${g('OPEN')} | ${g('INPUT')} |`);
}
md.push('');
md.push('## System variables', '');
md.push(`- Documented: ${Object.keys(sysvars).length}; lexicon: ${lexicon.systemVariables.length}; all covered: ${lexicon.systemVariables.every((s) => sysvars[s]) ? 'yes' : 'NO'}`);
md.push(`- Read with documented type and rejected with the other type: ${by('sysvar').filter((r) => r.label === 'read' && r.ok).length} read OK, ${by('sysvar').filter((r) => r.label === 'wrongType' && !r.ok).length} wrong-type rejected`);
md.push(`- Problems: ${fail('sysvar').map((r) => `${r.key} (${r.label})`).join(', ') || 'none'}`);
md.push('- A scan of all 2- and 3-letter names found no system variables beyond the lexicon.', '');
md.push('## Mnemonics', '');
const bogusM = by('mnem').find((r) => r.key === 'QZ');
md.push(`- The checker ${bogusM?.ok ? 'accepts any quoted mnemonic (a bogus \'QZ\' compiled), so mnemonic names are NOT validated by the compiler' : 'rejects unknown mnemonics'}.`);
md.push(`- Mnemonics that did not compile in PRINT: ${fail('mnem').map((r) => r.key).join(', ') || 'none'}`, '');
md.push('## System parameters', '');
const bogusP = by('param').find((r) => r.key === 'Q9');
md.push(`- Parameters documented: ${Object.keys(params).length} (54 from Lib/_prmdef.en, the rest taken from the live PRM system variable of the 9.62 session).`);
md.push(`- The checker ${bogusP?.ok ? 'accepts any 2-character parameter in SET_PARAM (bogus \'Q9\' compiled), so existence is based on the PRM listing' : 'rejects unknown parameters'}.`);
md.push(`- SET_PARAM forms rejected: ${fail('param').map((r) => r.key).join(', ') || 'none'}`, '');
fs.writeFileSync(path.join(docs, 'VALIDATION.md'), md.join('\n') + '\n');
fs.writeFileSync(path.join(docs, '.validation-raw.json'), JSON.stringify(results.filter((r) => !pass(r)), null, 1));
console.log(`cases ${results.length}, failing expectation ${results.filter((r) => !pass(r)).length}`);
