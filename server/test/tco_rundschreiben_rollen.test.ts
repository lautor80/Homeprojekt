/**
 * Rundschreiben an Rollen (Rechenteil ohne Datenbank): Benutzer gewählter Rollen kommen zu den Mitgliedern dazu –
 * einem Mitglied zugeordnete Benutzer zählen als Mitglied (keine doppelte E-Mail), sonst Adresse aus dem Kundenstamm vor
 * der des Benutzerkontos; gesperrte nie; einzelne Benutzer per „B:<Id>“ hinzufügen bzw. ausschließen; Altersgruppe und
 * Beitragsart wirken nur auf Mitglieder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUSWAHL_LEER, auswahlAus, benutzerAdresse, empfaengerErmitteln, nameZerlegen, type Benutzer, type Person,
} from '../../modules/tco/server/rundschreiben/empfaenger.js';

const HEUTE = '2026-11-22';
const p = (adrnr: string, vorname: string, nachname: string, rest: Partial<Person> = {}): Person => ({
  adrnr, vorname, nachname, email: '', emailkih: '', zahler: '', geburtsdatum: '1980-01-01', eintritt: '2020-01-01', austritt: null, strasse: '', plz: '', ort: '', schnupper: false, ...rest,
});
const b = (id: string, vorname: string, nachname: string, rest: Partial<Benutzer> = {}): Benutzer => ({
  id, vorname, nachname, email: '', emailBenutzer: '', aktiv: true, adrnr: '', rollen: ['HALLENNUTZER'], strasse: '', plz: '', ort: '', ...rest,
});
const personen = [
  p('9101', 'Anna', 'Mitglied', { email: 'anna@rr.example' }),
  p('9102', 'Kim', 'Jung', { geburtsdatum: '2015-01-01', email: 'kim@rr.example' }),
  p('9103', 'Olaf', 'Ehemals', { austritt: '2025-12-31', email: 'olaf@rr.example' }),
];
const benutzer = [
  b('u-kunde', 'Hugo', 'Halle', { email: 'hugo@rr.example', emailBenutzer: 'hugo.konto@rr.example', strasse: 'Hallenweg 1', plz: '66649', ort: 'Oberthal' }),
  b('u-konto', 'Hanna', 'Halle', { emailBenutzer: 'hanna@rr.example' }),
  b('u-gesperrt', 'Gerd', 'Gesperrt', { aktiv: false, emailBenutzer: 'gerd@rr.example' }),
  b('u-anna', 'Anna', 'Mitglied', { adrnr: '9101', emailBenutzer: 'anna.anders@rr.example', rollen: ['HALLENNUTZER', 'MITGLIED'] }),
  b('u-olaf', 'Olaf', 'Ehemals', { adrnr: '9103', emailBenutzer: 'olaf.halle@rr.example' }),
  b('u-ohne', 'Otto', 'Ohne', { strasse: 'Netzgasse 2', plz: '66649', ort: 'Oberthal' }),
  b('u-trainer', 'Tina', 'Trainer', { rollen: ['TRAINER'], emailBenutzer: 'tina@rr.example' }),
  b('u-dublette', 'Hans', 'Halle', { email: 'HUGO@rr.example' }),
];
const rechne = (auswahl: Partial<typeof AUSWAHL_LEER>) =>
  empfaengerErmitteln({ personen, benutzer, auswahl: { ...AUSWAHL_LEER, ...auswahl }, inGruppen: new Set(), arten: new Map(), verknuepfungen: [], heute: HEUTE });

test('nur Rolle Hallennutzer: Kundenstamm vor Benutzerkonto, Mitglied als Mitglied, gesperrt nie, Ausgetretener als Benutzer', () => {
  const r = rechne({ rollen: ['HALLENNUTZER'] });
  assert.deepEqual(r.empfaenger.map((e) => [e.email.toLowerCase(), e.anrede, e.weg, e.adrnrs.join(','), e.benutzer.join(',')]).sort(), [
    ['anna@rr.example', 'Hallo Anna', 'EIGEN', '9101', ''],
    ['hanna@rr.example', 'Hallo Hanna', 'BENUTZER', '', 'u-konto'],
    ['hugo@rr.example', 'Hallo Hans und Hugo', 'KUNDE', '', 'u-dublette,u-kunde'],
    ['olaf.halle@rr.example', 'Hallo Olaf', 'BENUTZER', '', 'u-olaf'],
  ]);
  assert.deepEqual(r.ohneMail.map((o) => [o.adrnr, o.benutzer, o.name, o.grund, o.strasse]), [['', 'u-ohne', 'Otto Ohne', 'keine E-Mail-Adresse', 'Netzgasse 2']]);
  assert.equal(r.personen, 6);
  assert.equal(r.dubletten, 1, 'Hugo und Hans teilen sich eine Adresse');
});

test('Rollen zusätzlich zu allen Mitgliedern: keine doppelte E-Mail an Mitglieder mit Benutzer', () => {
  const r = rechne({ alle: true, rollen: ['HALLENNUTZER'] });
  const anna = r.empfaenger.filter((e) => e.adrnrs.includes('9101'));
  assert.equal(anna.length, 1);
  assert.equal(r.empfaenger.filter((e) => /^anna/.test(e.email)).length, 1, 'nicht zusätzlich an die Adresse des Benutzerkontos');
  assert.ok(r.empfaenger.some((e) => e.email === 'kim@rr.example'), 'Mitglieder wie bisher');
  assert.ok(!r.empfaenger.some((e) => e.email === 'tina@rr.example'), 'andere Rolle nicht gewählt');
});

test('Altersgruppe und Beitragsart grenzen nur Mitglieder ein, nicht die Rollen', () => {
  const r = rechne({ alle: true, alter: 'JUGEND', rollen: ['HALLENNUTZER'] });
  const mails = r.empfaenger.map((e) => e.email.toLowerCase()).sort();
  assert.ok(mails.includes('kim@rr.example'));
  assert.ok(mails.includes('hanna@rr.example'));
  assert.ok(mails.includes('anna@rr.example'), 'Anna kommt über ihre Rolle dazu');
});

test('einzelne Benutzer hinzufügen und ausschließen (B:<Id>), gesperrte auch einzeln nie', () => {
  let r = rechne({ dazu: ['B:u-trainer', 'B:u-gesperrt', 'B:gibtsnicht'] });
  assert.deepEqual(r.empfaenger.map((e) => e.email), ['tina@rr.example']);
  r = rechne({ rollen: ['HALLENNUTZER'], ohne: ['B:u-konto', 'B:u-anna', 'B:u-ohne'] });
  assert.deepEqual(r.empfaenger.map((e) => e.email.toLowerCase()).sort(), ['hugo@rr.example', 'olaf.halle@rr.example']);
  assert.equal(r.ausgeschlossen, 3);
  assert.equal(r.ohneMail.length, 0);
  // Ausschluss über die Mitgliedsnummer gilt auch, wenn das Mitglied über seine Rolle käme
  r = rechne({ rollen: ['HALLENNUTZER'], ohne: ['9101'] });
  assert.ok(!r.empfaenger.some((e) => e.adrnrs.includes('9101')));
});

test('ohne Rollen bleibt alles wie bisher; ältere Auswahl ohne Feld „rollen“', () => {
  const r = rechne({ alle: true });
  assert.ok(r.empfaenger.every((e) => e.benutzer.length === 0));
  assert.deepEqual(auswahlAus({ alle: true }).rollen, []);
  assert.deepEqual(auswahlAus({ rollen: ['A', 'A', 'B'] }).rollen, ['A', 'B']);
});

test('Hilfen: Adresse eines Benutzers, Anzeigename zerlegen', () => {
  assert.deepEqual(benutzerAdresse({ email: 'kaputt', emailBenutzer: 'ok@rr.example' }), { email: 'ok@rr.example', weg: 'BENUTZER' });
  assert.equal(benutzerAdresse({ email: '', emailBenutzer: '' }), null);
  assert.deepEqual(nameZerlegen('Laub, Torsten'), { vorname: 'Torsten', nachname: 'Laub' });
  assert.deepEqual(nameZerlegen('Torsten  Laub'), { vorname: 'Torsten', nachname: 'Laub' });
  assert.deepEqual(nameZerlegen('hallenwart'), { vorname: 'hallenwart', nachname: '' });
});
