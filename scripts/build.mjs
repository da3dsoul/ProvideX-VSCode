// Bundles the extension client and the language server with esbuild.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const configs = [
  { ...common, entryPoints: ['client/src/extension.ts'], outfile: 'dist/client.js', external: ['vscode'] },
  { ...common, entryPoints: ['server/src/server.ts'], outfile: 'dist/server.js' },
];

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
