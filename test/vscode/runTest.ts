// Runs the extension integration suite inside a real VS Code instance (isolated profile).
// Uses VSCODE_EXECUTABLE if set (e.g. your installed Code.exe), otherwise downloads VS Code.
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pvx-vscode-'));
  const ws = path.join(work, 'ws');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'demo.pvx'), [
    'DEF CLASS "Demo_Widget"',
    'PROPERTY Name$',
    'FUNCTION Greet(who$)GREET',
    'END DEF',
    'GREET:',
    'ENTER who$',
    'LET w=NEW("Demo_Widget"), x$=UCS(who$)',
    'GOSUB NOWHERE',
    'RETURN 1',
  ].join('\r\n'));
  const compiled = process.env.PVX_SAMPLE_PROGRAM;
  if (compiled && fs.existsSync(compiled)) fs.copyFileSync(compiled, path.join(ws, 'sample.pvc'));
  fs.mkdirSync(path.join(ws, '.vscode'));
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({ 'providex.home': process.env.PVX_HOME ?? '', 'providex.compiled.confirmSave': false }));
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'vscode', 'suite.js'),
    launchArgs: [ws, '--disable-extensions', '--user-data-dir', path.join(work, 'user'), '--extensions-dir', path.join(work, 'ext'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
    extensionTestsEnv: { PVX_HOME: process.env.PVX_HOME ?? '', PVX_WS: ws },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
