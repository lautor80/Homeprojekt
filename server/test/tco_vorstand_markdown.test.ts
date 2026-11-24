/**
 * Vorstandssitzungen: reine Regeln und Import alter Protokolle aus Markdown – ohne Datenbank.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abstimmungLesen, abstimmungText, beschlussfaehig, beschlussNr, datumLesen, namenLesen, personZuordnen, sitzungNr, zeitenLesen,
} from '../../modules/tco/server/vorstand/regeln.js';
import { aufgabeLesen, markdownLesen, mdZaehlen } from '../../modules/tco/server/vorstand/markdown.js';

test('Nummern von Sitzung und Beschluss', () => {
  assert.equal(sitzungNr(2090, 7), 'VS 2090/07');
  assert.equal(beschlussNr(2090, 24), 'B 2090/024');
});

test('Beschlussfähigkeit: mehr als die Hälfte des Vorstands anwesend, Gäste zählen nicht', () => {
  const v = (status: 'ANWESEND' | 'ENTSCHULDIGT' | 'OFFEN') => ({ art: 'VORSTAND' as const, status });
  const g = { art: 'GAST' as const, status: 'ANWESEND' as const };
  assert.deepEqual(beschlussfaehig([v('ANWESEND'), v('ANWESEND'), v('ENTSCHULDIGT'), g]), { anwesend: 2, gesamt: 3, ok: true });
  assert.deepEqual(beschlussfaehig([v('ANWESEND'), v('ENTSCHULDIGT'), g, g]), { anwesend: 1, gesamt: 2, ok: false });
  assert.deepEqual(beschlussfaehig([g]), { anwesend: 0, gesamt: 0, ok: null });
});

test('Abstimmung aus Text', () => {
  assert.deepEqual(abstimmungLesen('6/0/1'), { ja: 6, nein: 0, enthaltung: 1, ergebnis: 'ANGENOMMEN' });
  assert.deepEqual(abstimmungLesen('2:4:0'), { ja: 2, nein: 4, enthaltung: 0, ergebnis: 'ABGELEHNT' });
  assert.deepEqual(abstimmungLesen('5 Ja, 1 Nein, 0 Enthaltungen'), { ja: 5, nein: 1, enthaltung: 0, ergebnis: 'ANGENOMMEN' });
  assert.deepEqual(abstimmungLesen('einstimmig angenommen'), { ja: null, nein: 0, enthaltung: null, ergebnis: 'ANGENOMMEN' });
  assert.deepEqual(abstimmungLesen('einstimmig bei 1 Enthaltung'), { ja: null, nein: 0, enthaltung: 1, ergebnis: 'ANGENOMMEN' });
  assert.equal(abstimmungLesen('abgelehnt')?.ergebnis, 'ABGELEHNT');
  assert.equal(abstimmungLesen('Diskussion vertagt'), null);
  assert.equal(abstimmungText({ ja: 5, nein: 0, enthaltung: 1, ergebnis: 'ANGENOMMEN' }), 'Ja 5 · Nein 0 · Enthaltung 1 – angenommen');
});

test('Datum und Uhrzeit aus Text', () => {
  assert.equal(datumLesen('2090-12-03_Vorstand.md'), '2090-12-03');
  assert.equal(datumLesen('Sitzung am 3.12.2090'), '2090-12-03');
  assert.equal(datumLesen('03.12.90'), '2090-12-03');
  assert.equal(datumLesen('3. Dezember 2090'), '2090-12-03');
  assert.equal(datumLesen('31.02.2090'), null);
  assert.equal(datumLesen('bis 10.12.', '2090-12-03'), '2090-12-10');
  assert.equal(datumLesen('bis 15.1.', '2090-12-03'), '2091-01-15');
  assert.equal(datumLesen('bis 15.1.'), null);
  assert.deepEqual(zeitenLesen('19:30–21:45 Uhr'), { beginn: '19:30', ende: '21:45' });
  assert.deepEqual(zeitenLesen('03.12.2090, 19.30 Uhr'), { beginn: '19:30', ende: null });
});

test('Namenslisten und Zuordnung zu Vorstandsmitgliedern', () => {
  assert.deepEqual(namenLesen('Laub, Torsten, Muster, Erika'), ['Laub, Torsten', 'Muster, Erika']);
  assert.deepEqual(namenLesen('Torsten Laub, Erika Muster und Hans Beispiel'), ['Torsten Laub', 'Erika Muster', 'Hans Beispiel']);
  assert.deepEqual(namenLesen('Laub, Torsten; Muster, Erika (Kassenwartin)'), ['Laub, Torsten', 'Muster, Erika (Kassenwartin)']);
  assert.deepEqual(namenLesen('–'), []);
  const P = [
    { adrnr: 'VS1', vorname: 'Torsten', nachname: 'Laub' }, { adrnr: 'VS2', vorname: 'Erika', nachname: 'Muster' },
    { adrnr: 'VS3', vorname: 'Hans', nachname: 'Muster' }, { adrnr: 'VS4', vorname: 'Jörg', nachname: 'Groß-Weber' },
  ];
  assert.equal(personZuordnen('Laub, Torsten', P)?.adrnr, 'VS1');
  assert.equal(personZuordnen('Torsten Laub', P)?.adrnr, 'VS1');
  assert.equal(personZuordnen('T. Laub', P)?.adrnr, 'VS1');
  assert.equal(personZuordnen('Laub', P)?.adrnr, 'VS1');
  assert.equal(personZuordnen('Erika Muster (Kassenwartin)', P)?.adrnr, 'VS2');
  assert.equal(personZuordnen('Muster', P), null, 'Nachname nicht eindeutig');
  assert.equal(personZuordnen('Joerg Gross Weber', P)?.adrnr, 'VS4');
  assert.equal(personZuordnen('Fremder Gast', P), null);
});

test('Aufgabe: Verantwortliche und Fälligkeit', () => {
  assert.deepEqual(aufgabeLesen('Aushang Halle aktualisieren @Hallenwart bis 10.12.', '2090-12-03'),
    { art: 'AUFGABE', text: 'Aushang Halle aktualisieren', verantwortlich: 'Hallenwart', faellig: '2090-12-10' });
  assert.deepEqual(aufgabeLesen('Angebote einholen (Torsten, bis 15.01.2091)', null),
    { art: 'AUFGABE', text: 'Angebote einholen', verantwortlich: 'Torsten', faellig: '2091-01-15' });
  assert.deepEqual(aufgabeLesen('Termin abstimmen → Platzwart', null),
    { art: 'AUFGABE', text: 'Termin abstimmen', verantwortlich: 'Platzwart', faellig: null });
});

const BEISPIEL = `---
datum: 2090-12-03
ort: Clubhaus
zeit: 19:30 - 21:45
anwesend: Laub, Torsten, Muster, Erika
entschuldigt:
  - Hans Muster
protokoll: Torsten Laub
---
# Vorstandssitzung Dezember

Beschlussfähigkeit wurde festgestellt.

## TOP 1 Begrüßung
Begrüßung durch die Vorsitzende.

## TOP 2: Hallenpreise Winter
Bericht: Hallenwart

Diskussion zu den Stundenpreisen, siehe [Preisliste](anlagen/Preisliste%20Winter.pdf).

**Beschluss:** Die Preise bleiben unverändert.
Abstimmung: 5 Ja, 0 Nein, 1 Enthaltung

- [ ] Aushang Halle aktualisieren @Hallenwart bis 10.12.
- [x] Preise im Portal prüfen @Kassenwart

### Nachtrag
Info: Neue Bälle sind bestellt.

## 3. Verschiedenes
- Beschluss: Sommerfest am 1.7.2091 (einstimmig)
- Aufgabe: Zelt reservieren (Erika, bis 01.05.2091)
![Foto](bilder/zelt.jpg)
`;

test('Markdown: Kopfdaten, Tagesordnung, Beschlüsse, Aufgaben, Anlagen', () => {
  const p = markdownLesen(BEISPIEL, 'protokoll.md');
  assert.equal(p.titel, 'Vorstandssitzung Dezember');
  assert.equal(p.datum, '2090-12-03');
  assert.equal(p.beginn, '19:30');
  assert.equal(p.ende, '21:45');
  assert.equal(p.ort, 'Clubhaus');
  assert.equal(p.protokoll, 'Torsten Laub');
  assert.deepEqual(p.anwesend, ['Laub, Torsten', 'Muster, Erika']);
  assert.deepEqual(p.entschuldigt, ['Hans Muster']);
  assert.equal(p.bemerkung, 'Beschlussfähigkeit wurde festgestellt.');
  assert.deepEqual(p.tops.map((t) => t.titel), ['Begrüßung', 'Hallenpreise Winter', 'Verschiedenes']);
  const t2 = p.tops[1];
  assert.equal(t2.verantwortlich, 'Hallenwart');
  assert.match(t2.text, /Diskussion zu den Stundenpreisen, siehe Preisliste\./);
  assert.match(t2.text, /\*\*Nachtrag\*\*/);
  assert.deepEqual(t2.anlagen, ['Preisliste Winter.pdf']);
  assert.deepEqual(t2.eintraege, [
    { art: 'BESCHLUSS', text: 'Die Preise bleiben unverändert.', ja: 5, nein: 0, enthaltung: 1, ergebnis: 'ANGENOMMEN' },
    { art: 'AUFGABE', text: 'Aushang Halle aktualisieren', verantwortlich: 'Hallenwart', faellig: '2090-12-10', erledigt: false },
    { art: 'AUFGABE', text: 'Preise im Portal prüfen', verantwortlich: 'Kassenwart', faellig: null, erledigt: true },
    { art: 'INFO', text: 'Neue Bälle sind bestellt.' },
  ]);
  const t3 = p.tops[2];
  assert.deepEqual(t3.eintraege, [
    { art: 'BESCHLUSS', text: 'Sommerfest am 1.7.2091', ja: null, nein: 0, enthaltung: null, ergebnis: 'ANGENOMMEN' },
    { art: 'AUFGABE', text: 'Zelt reservieren', verantwortlich: 'Erika', faellig: '2091-05-01' },
  ]);
  assert.deepEqual(t3.anlagen, ['zelt.jpg']);
  assert.deepEqual(mdZaehlen(p), { tops: 3, beschluesse: 2, aufgaben: 3, anlagen: ['Preisliste Winter.pdf', 'zelt.jpg'] });
  assert.deepEqual(p.hinweise, []);
});

test('Markdown: Datum aus dem Dateinamen, Kopfzeilen im Text, fette TOP-Absätze, Beschluss über mehrere Zeilen', () => {
  const p = markdownLesen([
    '# Protokoll der erweiterten Vorstandssitzung',
    'Ort: Online',
    'Anwesend: Torsten Laub; Erika Muster',
    'Gäste: Jugendtrainer',
    '',
    '**TOP 1: Jugendtraining**',
    'Die Trainerzeiten werden besprochen.',
    'Beschluss Nr. 7:',
    'Das Wintertraining beginnt am 3. November.',
    'Ergebnis: 6/0/0',
    '',
    '**TOP 2: Verschiedenes**',
    'Nichts.',
  ].join('\n'), '2090-10-01 Vorstand.md');
  assert.equal(p.datum, '2090-10-01');
  assert.equal(p.art, 'ERWEITERT');
  assert.equal(p.ort, 'Online');
  assert.deepEqual(p.anwesend, ['Torsten Laub', 'Erika Muster']);
  assert.deepEqual(p.gaeste, ['Jugendtrainer']);
  assert.deepEqual(p.tops.map((t) => t.titel), ['Jugendtraining', 'Verschiedenes']);
  assert.deepEqual(p.tops[0].eintraege, [{ art: 'BESCHLUSS', text: 'Das Wintertraining beginnt am 3. November.', ja: 6, nein: 0, enthaltung: 0, ergebnis: 'ANGENOMMEN' }]);
  assert.equal(p.tops[0].text, 'Die Trainerzeiten werden besprochen.');
});

test('Markdown: ohne Datum und ohne Tagesordnung gibt es Hinweise, der Text bleibt als ein Punkt erhalten', () => {
  const p = markdownLesen('Kurze Notiz ohne Gliederung.\nZweite Zeile.', 'notiz.md');
  assert.equal(p.datum, null);
  assert.equal(p.tops.length, 1);
  assert.equal(p.tops[0].text, 'Kurze Notiz ohne Gliederung.\nZweite Zeile.');
  assert.equal(p.hinweise.length, 2);
});

test('Markdown: Export aus Docmost/Joplin – Kopftabelle, Teilnehmer zum Ankreuzen, Tagesordnung als HTML-Tabelle', () => {
  const p = markdownLesen([
    '# 2090-08-13',
    '',
    '# Informationen',
    '',
    '|     |     |',
    '| --- | --- |',
    '| Datum | August 13, 2090 |',
    '| Verantwortlich | T. Laub |',
    '| Status |     |',
    '| Ort | Clubhaus |',
    '| Hinweis | Erstes Treffen nach Monaten |',
    '| **nächste Termine** |     |',
    '',
    '<details>',
    '<summary>Teilnehmer</summary>',
    '',
    '- [x] Torsten Laub (Beisitzer)',
    '- [x] Erika Muster',
    '- [ ] Hans Muster',
    '',
    '</details>',
    '',
    '# Agenda',
    '',
    '<div class="joplin-table-wrapper"><table><tbody>'
      + '<tr><th colspan="1"><p>Nr</p></th><th><p>Thema</p></th><th><p>Besprochen</p></th><th><p>Verantwortlich</p></th></tr>'
      + '<tr><td colspan="4" style="background-color: #b4d5ff;"><p></p></td></tr>'
      + '<tr><td><p>1</p></td><td><p>Hallenpreise</p></td><td><p>Abos bleiben gleich.</p><p>Einzelbuchung <strong>2€/Stunde </strong>mehr &amp; fertig.</p></td><td><p>Kasper</p></td></tr>'
      + '<tr><td><p>2</p></td><td><p>Jugendtraining</p></td><td><p>Beitrag auf 28,50€ ab 01.10.2090. Einstimmiger Beschluss durch den Vorstand.</p>'
      + '<img src="files/0190/image.png" width="2806"></td><td><p></p></td></tr>'
      + '<tr><td><p>3</p></td><td><p>Winterrunde</p></td><td><ul><li><p>Meldeschluss Sonntag</p></li><li><p>Wen fragen?</p><ul><li><p>Herren =&gt; Jan</p></li></ul></li></ul><p>Bälle zahlt der Verein.</p></td><td><p></p></td></tr>'
      + '<tr><td style="background-color: #b4d5ff;"><p></p></td><td colspan="2"><p><strong>allgemeine Themen</strong></p></td><td><p></p></td></tr>'
      + '<tr><td><p>4</p></td><td><p></p></td><td><p></p></td><td><p></p></td></tr>'
      + '</tbody></table></div>',
  ].join('\n'), '2090-08-13.md');
  assert.equal(p.titel, null, 'Titel nur Datum → Titel aus Art und Datum');
  assert.equal(p.datum, '2090-08-13');
  assert.equal(p.ort, 'Clubhaus');
  assert.equal(p.protokoll, 'T. Laub');
  assert.deepEqual(p.anwesend, ['Torsten Laub (Beisitzer)', 'Erika Muster']);
  assert.deepEqual(p.entschuldigt, ['Hans Muster']);
  assert.equal(p.bemerkung, 'Hinweis: Erstes Treffen nach Monaten');
  assert.deepEqual(p.tops.map((t) => t.titel), ['Hallenpreise', 'Jugendtraining', 'Winterrunde'], 'leere Zeilen und Zwischenüberschriften entfallen');
  assert.equal(p.tops[0].verantwortlich, 'Kasper');
  assert.equal(p.tops[0].text, 'Abos bleiben gleich.\n\nEinzelbuchung **2€/Stunde** mehr & fertig.');
  assert.equal(p.tops[0].eintraege.length, 0, 'keine Aufgaben aus der Teilnehmerliste');
  assert.deepEqual(p.tops[1].eintraege, [
    { art: 'BESCHLUSS', text: 'Beitrag auf 28,50€ ab 01.10.2090. Einstimmiger Beschluss durch den Vorstand.', ja: null, nein: 0, enthaltung: null, ergebnis: 'ANGENOMMEN' },
  ]);
  assert.deepEqual(p.tops[1].anlagen, ['image.png']);
  assert.equal(p.tops[1].text, '', 'Bild ohne Beschreibung nur als Anlage');
  assert.equal(p.tops[2].text, '- Meldeschluss Sonntag\n- Wen fragen?\n- – Herren => Jan\n\nBälle zahlt der Verein.');
  assert.ok(!p.tops.some((t) => /<|\|/.test(t.text)), 'kein HTML und keine Tabellenzeichen im Text');
  assert.deepEqual(p.hinweise, []);
});

test('Datum in englischer Schreibweise', () => {
  assert.equal(datumLesen('August 13, 2026'), '2026-08-13');
  assert.equal(datumLesen('March 1 2027'), '2027-03-01');
  assert.equal(datumLesen('13. August 2026'), '2026-08-13');
});
