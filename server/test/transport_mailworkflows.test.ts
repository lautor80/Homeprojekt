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

test('Absender je Dokumentart: je Art geprüft, BCC bereinigt; ältere Ablage (Spalte rechnung) gilt für R', () => {
  const e = einstellungenMischen({}, {
    T: { vorauswahl: true, modus: 'entwurf', absender: ' dispo@firma.example ', bcc: '' },
    L: { vorauswahl: true, modus: 'entwurf', absender: 'kaputt', bcc: '' },
    R: { vorauswahl: false, modus: 'senden', absender: 'buchhaltung@firma.example', bcc: 'a@b.example; c@d.example' },
  });
  assert.equal(e.versand.T.absender, 'dispo@firma.example');
  assert.deepEqual(e.versand.L, VERSAND_STANDARD.L, 'ungültige Art fällt einzeln auf den Standard');
  assert.deepEqual([e.versand.R.modus, e.versand.R.bcc], ['senden', 'a@b.example, c@d.example']);
  assert.deepEqual(e.rechnung, { absender: 'buchhaltung@firma.example', bcc: 'a@b.example, c@d.example' });
  // vor der Umstellung: versand ohne absender, Rechnungsversand in der Spalte rechnung
  const alt = einstellungenMischen({}, { R: { vorauswahl: true, modus: 'entwurf' } }, { absender: 'buchhaltung@firma.example', bcc: 'datev@upload.example' });
  assert.deepEqual([alt.versand.R.vorauswahl, alt.versand.R.absender, alt.versand.R.bcc], [true, 'buchhaltung@firma.example', 'datev@upload.example']);
  assert.equal(alt.versand.T.absender, '');
});

test('Eingangspostfächer: Adressen klein, Bezeichnung optional; Mischen und Anzeige-Liste', async () => {
  const e = einstellungenMischen({ postfaecher: [{ adresse: ' Info@Euro-Flex.de ', bezeichnung: 'Info' }, { adresse: 'buchhaltung@euro-flex.de' }] }, {});
  assert.deepEqual(e.eingang.postfaecher, [{ adresse: 'info@euro-flex.de', bezeichnung: 'Info' }, { adresse: 'buchhaltung@euro-flex.de', bezeichnung: '' }]);
  assert.deepEqual(einstellungenMischen({ postfaecher: [{ adresse: 'a@x.example' }, { adresse: 'A@x.example' }] }, {}).eingang.postfaecher, [], 'doppelt → Standard');
  const { postfachListe } = await import('../../modules/transport/server/eingang/logik.js');
  assert.deepEqual(postfachListe(e.eingang.postfaecher, ['buchhaltung@euro-flex.de', 'alt@euro-flex.de', 'INFO@euro-flex.de']), [
    { adresse: 'info@euro-flex.de', bezeichnung: 'Info' },
    { adresse: 'buchhaltung@euro-flex.de', bezeichnung: 'buchhaltung' },
    { adresse: 'alt@euro-flex.de', bezeichnung: 'alt@euro-flex.de' },
  ]);
});

