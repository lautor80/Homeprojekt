/**
 * Euroflex Mail-Workflows – Einstellungen (modules/transport/server/mailworkflows.ts): Standardwerte und Prüfung,
 * insbesondere Rechnungsversand (Absender-Postfach und BCC). Doku: docs/euroflex-mailworkflows.md, „Einstellungen“.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EINGANG_STANDARD, VERSAND_STANDARD, einstellungenMischen } from '../../modules/transport/server/mailworkflows.js';

test('Einstellungen: fehlende Werte fallen auf den Standard zurück, Rechnungsversand leer', () => {
  const e = einstellungenMischen(null, null);
  assert.deepEqual(e.eingang, EINGANG_STANDARD);
  assert.deepEqual(e.versand, VERSAND_STANDARD);
  assert.deepEqual(e.rechnung, { absender: '', bcc: '' });
});

test('Rechnungsversand: Adressen werden bereinigt, ungültige fallen auf leer zurück', () => {
  assert.deepEqual(einstellungenMischen({}, {}, { absender: ' buchhaltung@firma.example ', bcc: 'a@b.example; c@d.example' }).rechnung,
    { absender: 'buchhaltung@firma.example', bcc: 'a@b.example, c@d.example' });
  assert.deepEqual(einstellungenMischen({}, {}, { absender: 'kein-mail', bcc: '' }).rechnung, { absender: '', bcc: '' });
  assert.deepEqual(einstellungenMischen({}, {}, { absender: '', bcc: 'a@b.example, falsch' }).rechnung, { absender: '', bcc: '' });
});
