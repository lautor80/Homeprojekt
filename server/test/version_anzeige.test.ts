/**
 * Aktive Version in der Kopfzeile: Die CI gibt dem Image die Uhrzeit und Kennung des Commits mit, der Server liefert sie in
 * /api/auth/me, die Kopfzeile zeigt „Stand TT.MM. HH:MM“ neben dem Logo – ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lies = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');

test('Version: Text und Titel aus der Uhrzeit des Commits (deutsche Zeit)', async () => {
  const { versionText } = await import('../../web/src/version.js');
  assert.deepEqual(versionText({ zeit: '2026-11-14T19:03:20Z', sha: 'a1b2c3d' }),
    { text: 'Stand 14.11. 20:03', titel: 'Aktive Version: Code vom 14.11.2026, 20:03:20 (a1b2c3d)' });
  assert.equal(versionText({ zeit: '2026-07-01T22:30:00+02:00', sha: null })?.text, 'Stand 01.07. 22:30', 'Sommerzeit');
  assert.equal(versionText({ zeit: null, sha: null }), null, 'lokaler Start: keine Anzeige');
  assert.equal(versionText({ zeit: 'kaputt', sha: null }), null);
  assert.equal(versionText(undefined), null);
});

test('Version: CI → Image → Server → Kopfzeile', () => {
  const ci = lies('.github/workflows/ci.yml');
  assert.match(ci, /echo "zeit=\$\(git log -1 --format=%cI\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(ci, /BUILD_SHA=\$\{\{ github\.sha \}\}/);
  assert.match(ci, /BUILD_ZEIT=\$\{\{ steps\.version\.outputs\.zeit \}\}/);
  const docker = lies('Dockerfile');
  const laufzeit = docker.slice(docker.indexOf('# ---------- Laufzeit'));
  assert.match(laufzeit, /ARG BUILD_SHA=[^]*ARG BUILD_ZEIT=[^]*PORTAL_VERSION_SHA=\$BUILD_SHA[^]*PORTAL_VERSION_ZEIT=\$BUILD_ZEIT/, 'im Laufzeit-Abschnitt');
  assert.match(lies('server/src/routes/auth.ts'), /version: \{ zeit: process\.env\.PORTAL_VERSION_ZEIT \|\| null, sha: /);
  const shell = lies('web/src/shell/Shell.tsx');
  assert.match(shell, /const version = versionText\(me\.version\);/);
  assert.match(shell, /<small className="portal-kopf__version">\{version\.text\}<\/small>/);
});
