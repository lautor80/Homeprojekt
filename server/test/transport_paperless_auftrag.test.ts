/**
 * Euroflex ↔ Paperless über das Custom Field „Auftrag“: Feldwerte, Dubletten, Liste im Auftrag
 * (modules/transport/server/paperless-auftrag.ts) und die Migration lokaler Auftragsordner (modules/transport/web/migration-logik.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auftraegeImFeld, duplikatVon, feldErgaenzen, feldPasst, zeilenZusammenfuehren } from '../../modules/transport/server/paperless-auftrag.js';
import { auftragFuer, dateiDatum, ignorieren, kandidaten, typErlaubt, uebertragbar, zaehlen, type MigEintrag } from '../../modules/transport/web/migration-logik.js';

test('Feld „Auftrag“: mehrere Nummern, nur genaue Treffer', () => {
  assert.deepEqual(auftraegeImFeld('2098_0150, 2098_0153;2098_0150'), ['2098_0150', '2098_0153']);
  assert.deepEqual(auftraegeImFeld(null), []);
  assert.equal(feldPasst('2098_0150, 2098_0153', '2098_0153'), true);
  // Teiltreffer der Suche in Paperless (icontains) zählen nicht
  assert.equal(feldPasst('2098_01530', '2098_0153'), false);
  assert.equal(feldErgaenzen('2098_0150', '2098_0153'), '2098_0150, 2098_0153');
  assert.equal(feldErgaenzen('2098_0153', '2098_0153'), '2098_0153');
  assert.equal(feldErgaenzen(null, '2098_0153'), '2098_0153');
});

test('Dublette: Dokument-ID aus der Paperless-Meldung', () => {
  assert.equal(duplikatVon('Paperless konnte das Dokument nicht verarbeiten: Not consuming x.pdf: It is a duplicate of Lieferschein (#4711).'), 4711);
  assert.equal(duplikatVon('Paperless konnte das Dokument nicht verarbeiten: x.pdf: Document is a duplicate of #12'), 12);
  assert.equal(duplikatVon('Paperless-Fehler HTTP 500: kaputt #3'), null);
});

test('Liste im Auftrag: Portal und Feld zusammen, jedes Dokument einmal, neueste zuerst', () => {
  const feldId = 7;
  const doc = (id: number, created: string, wert: string | null, notes = 0) => ({
    id, title: `Dok ${id}`, original_file_name: `d${id}.pdf`, created, notes: Array.from({ length: notes }, (_, i) => ({ id: i })),
    custom_fields: wert === null ? [] : [{ field: feldId, value: wert }],
  });
  const portal = [{ doc_id: 1, titel: 'Auftrag 2098_0153 – CMR', datei: 'cmr.pdf', erstellt_am: '2098-05-01T10:00:00Z', erstellt_von: 'Max' }];
  const docs = [doc(1, '2098-04-30', null), doc(2, '2098-03-02', '2098_0153', 2), doc(3, '2098-06-01', '2098_0150, 2098_0153'), doc(4, '2098-07-01', '2098_01530')];
  const z = zeilenZusammenfuehren(portal, docs, { nr: '2098_0153', feldId, basis: 'http://paperless:8000' });
  assert.deepEqual(z.map((x) => [x.doc_id, x.quelle]), [[3, 'feld'], [1, 'portal'], [2, 'feld']]);
  assert.equal(z[1].titel, 'Auftrag 2098_0153 – CMR');
  assert.equal(z[1].datum, '2098-04-30');
  assert.equal(z[2].notizen, 2);
  assert.equal(z[2].link, 'http://paperless:8000/documents/2/details');
  // im Portal verknüpft und Feld gesetzt → beide
  const b = zeilenZusammenfuehren(portal, [doc(1, '2098-04-30', '2098_0153')], { nr: '2098_0153', feldId, basis: null });
  assert.equal(b[0].quelle, 'beide');
  assert.equal(b[0].link, null);
  // ohne Paperless (nicht erreichbar): nur die Portal-Zeilen
  assert.deepEqual(zeilenZusammenfuehren(portal, [], { nr: '2098_0153', feldId: null, basis: null }).map((x) => x.doc_id), [1]);
});

test('Migration: Auftrag aus dem Ordnerpfad – oberster Auftragsordner gilt auch für Unterordner', () => {
  const bekannt = new Set(['2098_0153', 'SAP-77']);
  assert.deepEqual(auftragFuer(['2098', '2098_0153'], bekannt), { nr: '2098_0153', bekannt: true, ebene: 1 });
  assert.deepEqual(auftragFuer(['2098', '2098_0153', 'Eingang', 'Fotos'], bekannt), { nr: '2098_0153', bekannt: true, ebene: 1 });
  // Ordnername mit Zusatz
  assert.deepEqual(auftragFuer(['2098', '2098_0153 Holz Müller'], bekannt), { nr: '2098_0153', bekannt: true, ebene: 1 });
  // beliebiger Ordnername, der im Portal ein Auftrag ist
  assert.deepEqual(auftragFuer(['Alt', 'SAP-77', 'x'], bekannt), { nr: 'SAP-77', bekannt: true, ebene: 1 });
  // nach Muster, aber im Portal unbekannt
  assert.deepEqual(auftragFuer(['2098', '2098_0999'], bekannt), { nr: '2098_0999', bekannt: false, ebene: 1 });
  // Jahresordner allein ist kein Auftrag
  assert.equal(auftragFuer(['2098'], bekannt), null);
  assert.equal(auftragFuer([], bekannt), null);
});

test('Migration: Kandidaten, Datum, Dateitypen, Zählung', () => {
  assert.deepEqual(kandidaten([['2098', '2098_0153 Müller'], ['2098', 'Eingang']]).sort(), ['2098', '2098_0153', '2098_0153 Müller', 'Eingang'].sort());
  assert.equal(dateiDatum(new Date(2098, 2, 2, 23, 30).getTime()), '2098-03-02');
  assert.equal(typErlaubt('CMR.PDF'), true);
  assert.equal(typErlaubt('mail.msg'), false);
  assert.equal(ignorieren('Thumbs.db'), true);
  assert.equal(ignorieren('~$Angebot.docx'), true);
  assert.equal(ignorieren('Lieferschein.pdf'), false);
  const e = (p: Partial<MigEintrag>): MigEintrag => ({ key: '1', pfad: '', ordner: [], datei: 'a.pdf', groesse: 1, datum: '2098-01-01', nr: '2098_0153', bekannt: true, status: 'offen', text: '', ...p });
  assert.equal(uebertragbar(e({}), false), true);
  assert.equal(uebertragbar(e({ bekannt: false }), false), false);
  assert.equal(uebertragbar(e({ bekannt: false }), true), true);
  assert.equal(uebertragbar(e({ nr: null }), true), false);
  const z = zaehlen([e({}), e({ status: 'neu' }), e({ status: 'fehler' }), e({ nr: null }), e({ datei: 'x.msg' }), e({ bekannt: false, nr: '2098_0999' })], false);
  assert.deepEqual({ ...z }, { dateien: 6, auftraege: 2, offen: 1, fertig: 1, fehler: 1, ohneAuftrag: 1, unbekannt: 1, typ: 1 });
});
