// Kopiert die SAP-Schrift "72" lokal nach web/public/fonts und erzeugt fonts.css.
// So lädt die Oberfläche nichts von einem CDN (Self-Hosting, Datenschutz, offline).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'web', 'public', 'fonts');
fs.mkdirSync(out, { recursive: true });

const fontDir = path.join(path.dirname(require.resolve('@sap-theming/theming-base-content/package.json')),
  'content', 'Base', 'baseLib', 'baseTheme', 'fonts');
const cssModule = path.join(root, 'node_modules', '@ui5', 'webcomponents-base', 'dist', 'generated', 'css', 'FontFace.css.js');
let css = (await import(cssModule)).default;

const used = new Set();
css = css.replace(/url\(https:\/\/[^)]*\/fonts\/([^)]+\.woff2)\)/g, (_, file) => {
  used.add(file);
  return `url(/fonts/${file})`;
});
for (const f of used) fs.copyFileSync(path.join(fontDir, f), path.join(out, f));
fs.writeFileSync(path.join(out, 'fonts.css'), css);
console.log(`Schriften lokal bereitgestellt: ${[...used].join(', ')}`);
