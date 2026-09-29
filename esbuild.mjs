import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');

// A fonte de ícones do VS Code não chega sozinha no webview; copiamos para media/ e o painel serve de lá.
const codiconsDir = 'media/codicons';
fs.mkdirSync(codiconsDir, { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  fs.copyFileSync(path.join('node_modules/@vscode/codicons/dist', file), path.join(codiconsDir, file));
}

// O SDK é ESM e usa import.meta.url; no bundle CommonJS isso vira a URL do próprio arquivo gerado.
const extension = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
};

const webview = {
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await Promise.all([(await esbuild.context(extension)).watch(), (await esbuild.context(webview)).watch()]);
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}
