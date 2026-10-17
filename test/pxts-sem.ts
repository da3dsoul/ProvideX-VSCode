// Debug helper: semantic tokens the language server returns for a .pxts text (converted from a corpus file).
//   npm run build && npx esbuild test/pxts-sem.ts --bundle --platform=node --outfile=out/pxts-sem.js && node out/pxts-sem.js <file.pvx> [from] [to]
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { toView } from '../server/src/view';
import { toPxts } from '../server/src/pxts/toPxts';

async function main() {
  const root = path.join(__dirname, '..');
  const arg = process.argv[2];
  const ts = arg.endsWith('.pxts') ? fs.readFileSync(arg, 'utf8') : toPxts(toView(fs.readFileSync(arg, 'latin1').split(/\r?\n/).filter((l) => l.trim())).text).text;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxts-sem-'));
  const uri = 'file:///' + path.join(tmp, 'x.pxts').replace(/\\/g, '/');
  const proc = spawn(process.execPath, [path.join(root, 'dist', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const conn = createMessageConnection(new StreamMessageReader(proc.stdout!), new StreamMessageWriter(proc.stdin!));
  conn.onRequest('workspace/configuration', () => [{ home: '', bridge: { enabled: false }, diagnostics: { useProvideX: 'off' } }]);
  conn.onRequest('client/registerCapability', () => null);
  conn.onNotification(() => undefined);
  conn.listen();
  const init = await conn.sendRequest<{ capabilities: { semanticTokensProvider: { legend: { tokenTypes: string[]; tokenModifiers: string[] } } } }>('initialize', {
    processId: process.pid, rootUri: null, workspaceFolders: null,
    capabilities: { workspace: { configuration: true }, textDocument: { semanticTokens: { requests: { full: true } } } },
    initializationOptions: { bridgeScript: '', detectedHome: '' },
  });
  const legend = init.capabilities.semanticTokensProvider.legend;
  conn.sendNotification('initialized', {});
  conn.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'pxts', version: 1, text: ts } });
  const st = await conn.sendRequest<{ data: number[] }>('textDocument/semanticTokens/full', { textDocument: { uri } });
  const lines = ts.split('\n');
  const byLine = new Map<number, string[]>();
  let line = 0, col = 0;
  for (let k = 0; k < st.data.length; k += 5) {
    const [dl, dc, len, type, mod] = st.data.slice(k, k + 5);
    line += dl; col = dl ? dc : col + dc;
    const mods = legend.tokenModifiers.filter((_, b) => mod & (1 << b));
    const a = byLine.get(line) ?? [];
    a.push(`${JSON.stringify(lines[line].slice(col, col + len))}=${legend.tokenTypes[type]}${mods.length ? '.' + mods.join('.') : ''}`);
    byLine.set(line, a);
  }
  const from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? 60);
  for (let i = from; i < Math.min(to, lines.length); i++) console.log(String(i).padStart(4) + ' ' + lines[i] + '\n       ' + (byLine.get(i) ?? []).join('  '));
  await conn.sendRequest('shutdown').catch(() => undefined);
  conn.sendNotification('exit');
  proc.kill();
  process.exit(0);
}
main();
