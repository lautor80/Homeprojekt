/**
 * Bereitstellung (Docker Compose, Windows/Docker Desktop): Konfigurationsdateien ohne Datenbank prüfen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const lesen = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');

test('.gitattributes erzwingt LF für Skripte, Caddyfile und YAML (Checkout unter Windows)', () => {
  const ga = lesen('.gitattributes');
  for (const muster of ['*.sh', 'Caddyfile', '*.yml']) {
    assert.match(ga, new RegExp(`^${muster.replace(/[*.]/g, (c) => `\\${c}`)}\\s+text\\s+eol=lf$`, 'm'), muster);
  }
});

test('Shell-Skripte im Repository haben LF-Zeilenenden', () => {
  const skripte = ['install.sh', 'update.sh', 'restore.sh', 'backup/backup.sh', 'scripts/env.sh'];
  for (const f of skripte) assert.ok(!lesen(f).includes('\r'), `${f} enthält CR`);
  assert.ok(readdirSync(path.join(ROOT, 'backup')).includes('backup.sh'));
});

test('docker-compose: Paperless-Dokumente getrennt ablegbar, Eingangsordner per Abfrage', () => {
  const dc = lesen('docker-compose.yml');
  for (const d of ['media', 'export', 'consume']) {
    assert.ok(dc.includes(`\${PAPERLESS_ABLAGE_PFAD:-\${PAPERLESS_PFAD:-./data/paperless}}/${d}:/usr/src/paperless/${d}`), d);
  }
  // Datenbank und Index bleiben unter PAPERLESS_PFAD
  assert.ok(dc.includes('${PAPERLESS_PFAD:-./data/paperless}/db:/var/lib/postgresql/data'));
  assert.ok(dc.includes('${PAPERLESS_PFAD:-./data/paperless}/data:/usr/src/paperless/data'));
  assert.ok(dc.includes('PAPERLESS_CONSUMER_POLLING: ${PAPERLESS_CONSUMER_POLLING:-0}'));
  assert.ok(lesen('portainer-stack-komplett.yml').includes('PAPERLESS_CONSUMER_POLLING: ${PAPERLESS_CONSUMER_POLLING:-0}'));
});

test('.env.example kennt die neuen Einstellungen (update.sh ergänzt sie in bestehenden Installationen)', () => {
  const env = lesen('.env.example');
  assert.match(env, /^PAPERLESS_ABLAGE_PFAD=$/m);
  assert.match(env, /^PAPERLESS_CONSUMER_POLLING=0$/m);
});
