// Debug helper: show the TextMate scopes of a .pxts text (converted from a corpus file) line by line.
//   npx esbuild test/pxts-hl.ts --bundle --platform=node --outfile=out/pxts-hl.js --external:vscode-oniguruma --external:vscode-textmate && node out/pxts-hl.js <file.pvx> [from] [to]
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
  const arg = process.argv[2];
  const ts = arg.endsWith('.pxts') ? fs.readFileSync(arg, 'utf8') : toPxts(toView(fs.readFileSync(arg, 'latin1').split(/\r?\n/).filter((l) => l.trim())).text).text;
  const lines = ts.split('\n');
  let st = vsctm.INITIAL;
  const from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? 60);
  lines.forEach((line, i) => {
    const r = g.tokenizeLine(line, st);
    st = r.ruleStack;
    if (i < from || i >= to) return;
    console.log(String(i).padStart(4) + ' ' + line);
    for (const t of r.tokens) {
      const txt = line.slice(t.startIndex, t.endIndex);
      if (!txt.trim()) continue;
      console.log('       ' + JSON.stringify(txt).padEnd(28) + ' ' + t.scopes.slice(1).join(' > '));
    }
  });
}
main();
