// Debug helper: TextMate-highlight many converted corpus files and report suspicious scopes.
//   npx esbuild test/pxts-hl-survey.ts --bundle --platform=node --outfile=out/pxts-hl-survey.js --external:vscode-oniguruma --external:vscode-textmate && node out/pxts-hl-survey.js <corpusDir> [maxFiles]
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = fs.readFileSync(path.join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const files: Record<string, string> = { 'source.pxts': 'pxts.tmLanguage.json', 'source.providex': 'providex.tmLanguage.json' };
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({ createOnigScanner: (p) => new oniguruma.OnigScanner(p), createOnigString: (s) => new oniguruma.OnigString(s) }),
    loadGrammar: async (scope) => (files[scope] ? vsctm.parseRawGrammar(fs.readFileSync(path.join(root, 'syntaxes', files[scope]), 'utf8'), files[scope]) : null),
  });
  const g = (await registry.loadGrammar('source.pxts'))!;
  const corpus = process.argv[2];
  const list = (fs.readdirSync(corpus, { recursive: true } as never) as string[]).map(String).filter((f) => f.endsWith('.pvx')).slice(0, Number(process.argv[3] ?? 300));
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  const note = (k: string, s: string) => { counts.set(k, (counts.get(k) ?? 0) + 1); const a = samples.get(k) ?? []; if (a.length < 4) a.push(s); samples.set(k, a); };
  for (const rel of list) {
    const text = fs.readFileSync(path.join(corpus, rel), 'latin1');
    if (text.split('\n').some((l) => /^\d+\?/.test(l))) continue;
    const ts = toPxts(toView(text.split(/\r?\n/).filter((l) => l.trim())).text).text;
    let st = vsctm.INITIAL;
    ts.split('\n').forEach((line, i) => {
      const r = g.tokenizeLine(line, st);
      st = r.ruleStack;
      for (const t of r.tokens) {
        const txt = line.slice(t.startIndex, t.endIndex);
        if (!txt.trim()) continue;
        const top = t.scopes[t.scopes.length - 1];
        const where = `${rel}:${i}: ${line.trim().slice(0, 110)}  [${JSON.stringify(txt)}]`;
        if (top.includes('string.quoted.single')) note('single-quoted string', where);
        if (t.scopes.length > 2 && t.scopes.some((s) => s.includes('meta.embedded')) && !line.includes('pvx`')) note('embedded ProvideX outside pvx`` line', where);
        if (top === 'source.pxts' && /[A-Za-z]/.test(txt)) note('unscoped word', where);
        if (top.includes('storage.type') && !/^(function|let|const|class|extends|public|private|readonly|constructor|destructor|new|def|get|set|create|delete|required)$/.test(txt)) note('storage.type on ' + txt, where);
        if (top.includes('keyword.control') && /\w\(/.test(line.slice(t.startIndex)) && line[t.endIndex] === '(') note('keyword before (', where);
        if (top.includes('string.quoted.double') && i > 0 && t.startIndex === 0 && !line.trim().startsWith('"')) note('string continued from previous line', where);
        if (top.includes('storage.type') && /^(get|set|new|delete|create|required)$/.test(txt) && !/^\s*(get|set) \w+\(|new \w|@(create|delete)\(|required/.test(line)) note('decl word used as name: ' + txt, where);
      }
    });
  }
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${n}  ${k}`);
    for (const s of samples.get(k)!) console.log('      ' + s);
  }
}
main();
