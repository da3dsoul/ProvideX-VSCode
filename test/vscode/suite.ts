// Integration checks executed inside VS Code (see runTest.ts).
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as assert from 'assert';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 30000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error('timeout');
    await sleep(100);
  }
}

export async function run(): Promise<void> {
  const ws = process.env.PVX_WS!;
  const results: string[] = [];
  const check = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ': ' + (e as Error).message); }
  };

  const uri = vscode.Uri.file(path.join(ws, 'demo.pvx'));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);

  await check('language id', async () => assert.strictEqual(doc.languageId, 'providex'));
  await check('extension activates', async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'providex');
    assert.ok(ext);
    await waitFor(() => ext!.isActive);
  });
  await check('diagnostics', async () => {
    const d = await waitFor(() => { const x = vscode.languages.getDiagnostics(uri); return x.length ? x : undefined; });
    assert.ok(d.some((x) => /NOWHERE/.test(x.message)), JSON.stringify(d.map((x) => x.message)));
  });
  await check('hover', async () => {
    const h = await waitFor(async () => { const r = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(6, 30)); return r?.length ? r : undefined; });
    const text = h.map((x) => x.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)).join('')).join('');
    assert.match(text, /UCS/);
  });
  await check('completion', async () => {
    const c = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(8, 0));
    assert.ok(c.items.some((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'PRINT'));
  });
  await check('definition', async () => {
    const d = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, new vscode.Position(2, 23));
    assert.strictEqual(d[0].range.start.line, 4);
  });
  await check('document symbols', async () => {
    const s = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri);
    assert.ok(s.some((x) => x.name === 'Demo_Widget'));
  });
  await check('semantic tokens', async () => {
    const t = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', uri);
    assert.ok(t.data.length > 10);
  });
  await check('formatting', async () => {
    const e = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, { tabSize: 2, insertSpaces: true });
    assert.ok(e === undefined || Array.isArray(e));
  });

  const sample = path.join(ws, 'sample.pvc');
  if (process.env.PVX_HOME && fs.existsSync(sample)) {
    await check('open compiled program as source', async () => {
      await vscode.commands.executeCommand('providex.openCompiled', vscode.Uri.file(sample));
      const ed = await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'pvxprg' ? vscode.window.activeTextEditor : undefined, 60000);
      assert.strictEqual(ed.document.languageId, 'providex');
      // readable view: no statement numbers anywhere
      assert.ok(!/^\s*\d+\s/m.test(ed.document.getText()), 'statement numbers should be hidden');
    });
    await check('edit and save compiled program restores numbers', async () => {
      const ed = vscode.window.activeTextEditor!;
      const before = fs.statSync(sample).mtimeMs;
      // insert a statement after the first label in the program
      const firstLabel = [...Array(ed.document.lineCount).keys()].find((l) => /^\s*[A-Za-z_][A-Za-z0-9_.]*:\s*$/.test(ed.document.lineAt(l).text))!;
      await ed.edit((b) => b.insert(new vscode.Position(firstLabel + 1, 0), '  integrationTest$ = "inserted by test"\r\n'));
      assert.ok(await ed.document.save(), 'save failed');
      await waitFor(() => fs.statSync(sample).mtimeMs !== before ? true : undefined, 60000);
      assert.ok(fs.existsSync(sample + '.bak'), 'backup missing');
      const lines = await vscode.commands.executeCommand<string[]>('providex.debugDecompile', sample);
      assert.ok(lines.some((l) => /^\d+ (LET )?integrationTest\$="inserted by test"/.test(l)), 'inserted statement not found in compiled program: ' + lines.slice(0, 5).join(' | '));
      const nums = lines.map((l) => parseInt(l, 10));
      assert.ok(nums.every((x, i) => i === 0 || x > nums[i - 1]), 'statement numbers not increasing');
    });
    await check('open compiled program as ProvideX/TS, edit, save', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('providex.openCompiledAsPxts', vscode.Uri.file(sample));
      const ed = await waitFor(() => vscode.window.activeTextEditor?.document.uri.query === 'ts' ? vscode.window.activeTextEditor : undefined, 60000);
      assert.strictEqual(ed.document.languageId, 'pxts');
      const text = ed.document.getText();
      assert.ok(/\bclass \w+/.test(text) || /^\w+:$/m.test(text), 'expected TS-style class or labels');
      assert.ok(!/^\s*\d+\s/m.test(text), 'statement numbers should be hidden');
      // diagnostics from the TS document come back mapped
      const before = fs.statSync(sample).mtimeMs;
      // insert into the first method body (or after the first label of a program without classes)
      const firstLabel = [...Array(ed.document.lineCount).keys()].find((l) => /^\s+(private )?[A-Za-z_][A-Za-z0-9_]*\(.*\) \{\s*(\/\/.*)?$/.test(ed.document.lineAt(l).text) || /^[A-Za-z_][A-Za-z0-9_]*:\s*(\/\/.*)?$/.test(ed.document.lineAt(l).text))!;
      assert.ok(firstLabel !== undefined, 'no method or label found');
      await ed.edit((b) => b.insert(new vscode.Position(firstLabel + 1, 0), 'tsTest$ = "from pxts" + ucs("x")\r\n'));
      assert.ok(await ed.document.save(), 'save failed');
      await waitFor(() => fs.statSync(sample).mtimeMs !== before ? true : undefined, 60000);
      const lines = await vscode.commands.executeCommand<string[]>('providex.debugDecompile', sample);
      assert.ok(lines.some((l) => /tsTest\$="from pxts"\+UCS\("x"\)/i.test(l)), 'inserted statement not found: ' + lines.filter((l) => /tsTest/i.test(l)).join(' | '));
      const hov = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', ed.document.uri, new vscode.Position(firstLabel + 1, ed.document.lineAt(firstLabel + 1).text.indexOf('ucs') + 1));
      assert.ok(hov.length > 0, 'hover in .pxts');
    });
    await check('custom editor redirects .pvc', async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(sample));
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.scheme === 'pvxprg' ? true : undefined, 60000);
    });
  }

  fs.writeFileSync(path.join(ws, 'results.txt'), results.join('\n'));
  console.log(results.join('\n'));
  if (results.some((r) => r.startsWith('FAIL'))) throw new Error(results.filter((r) => r.startsWith('FAIL')).join('\n'));
}
