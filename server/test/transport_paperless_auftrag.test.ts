/**
 * Euroflex ↔ Paperless über das Custom Field „Auftrag“: Feldwerte, Dubletten, Liste im Auftrag
 * (modules/transport/server/paperless-auftrag.ts) und die Migration lokaler Auftragsordner (modules/transport/web/migration-logik.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auftraegeImFeld, duplikatVon, feldErgaenzen, feldPasst, zeilenZusammenfuehren } from '../../modules/transport/server/paperless-auftrag.js';
import { PaperlessError, type Paperless } from '../src/lib/paperless.js';
import { alsVersion, versionLabel } from '../../modules/transport/server/paperless-version.js';
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

// ---------------------------------------------------------------- Neudruck: neue Version statt neuem Dokument

test('Versionsbezeichnung: Neudruck bzw. Versand mit Datum und Uhrzeit (Berlin)', () => {
  assert.equal(versionLabel('druck', new Date('2098-11-19T17:05:00Z')), 'Neudruck 19.11.2098 18:05');
  assert.equal(versionLabel('versand', new Date('2098-07-01T06:00:00Z')), 'Versand 01.07.2098 08:00');
});

test('Neudruck: Version am vorhandenen Dokument, unverändert bei Dublette, neues Dokument nur wenn gelöscht oder ohne Versionen', async () => {
  const fake = (o: { upload?: () => Promise<string>; warte?: () => Promise<number | null>; dokument?: () => Promise<unknown> }) =>
    ({ uploadVersion: o.upload ?? (async () => 'task'), warteAufDokument: o.warte ?? (async () => 55), dokument: o.dokument ?? (async () => ({ id: 1 })) }) as unknown as Paperless;
  assert.deepEqual(await alsVersion(fake({}), 1, Buffer.from('x'), 'a.pdf', 'Neudruck'), { art: 'version', versionId: 55 });
  assert.deepEqual(await alsVersion(fake({ warte: async () => { throw new PaperlessError('Paperless konnte das Dokument nicht verarbeiten: It is a duplicate of a (#1).'); } }), 1, Buffer.from('x'), 'a.pdf', 'x'), { art: 'unveraendert' });
  const r404 = async () => { throw new PaperlessError('Paperless-Fehler HTTP 404', 404); };
  const weg = await alsVersion(fake({ upload: r404, dokument: r404 }), 7, Buffer.from('x'), 'a.pdf', 'x');
  assert.equal(weg.art, 'neu');
  assert.match((weg as { grund: string }).grund, /Dokument 7 existiert nicht mehr/);
  const alt = await alsVersion(fake({ upload: r404 }), 7, Buffer.from('x'), 'a.pdf', 'x');
  assert.match((alt as { grund: string }).grund, /keine Dateiversionen/);
  await assert.rejects(alsVersion(fake({ upload: async () => { throw new PaperlessError('Paperless-Fehler HTTP 500', 500); } }), 7, Buffer.from('x'), 'a.pdf', 'x'), /500/);
});
