import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { logoWeiss, type Db, type Verein } from '../verein.js';
import { condense, dat, heute, ibanFormat } from '../format.js';
import { alleFusszeilen, betragText, C, kuerzen, LEFT, umbruch } from '../pdf/layout.js';
import { familieLesen, kontoinhaberText, leer, mandatsref, mitgliedLesen, vertraegeLesen, type Vertrag } from './logik.js';

/**
 * Mitgliederunterlagen im Layout der Hallenrechnung (Port von ZCL_TCO_MITGLIED_PDF):
 * 1 Aufnahmebestätigung, 2 Mitgliederinformation, 3 Mitgliedschaftsbestätigung,
 * 4 Kündigungsbestätigung, 5 SEPA-Lastschriftmandat.
 */

export const ARTEN = ['1', '2', '3', '4', '5'] as const;
export type Art = (typeof ARTEN)[number];
export const ART_TEXT: Record<Art, string> = {
  1: 'Aufnahmebestätigung', 2: 'Mitgliederinformation', 3: 'Mitgliedschaftsbestätigung', 4: 'Kündigungsbestätigung', 5: 'SEPA-Lastschriftmandat',
};
/** Paperless-Dokumenttypen wie in SAP (IDs 9–12); SEPA: erster Typ mit „SEPA“ oder „Mandat“ im Namen */
export const ART_DOKTYP: Record<Art, string> = {
  1: 'Aufnahmeantrag', 2: 'Mitgliederinformation', 3: 'Mitgliedschaftsbestätigung', 4: 'Kündigungsbestätigung', 5: 'SEPA-Lastschriftmandat',
};
const GLAEUBIGER_ID = 'DE65ZZZ00000112871';

const jn = (v: unknown) => (['J', 'X'].includes(leer(v).toUpperCase()) ? 'Ja' : leer(v).toUpperCase() === 'N' ? 'Nein' : '–');
const datOpt = (d: string | null | undefined) => (d ? dat(d) : '–');

interface Feld { x: number; w: number; label: string; wert: string }

class Brief {
  p: Pdf;
  y = 0;
  constructor(readonly v: Verein, titel: string) {
    this.p = new Pdf({ title: titel, author: v.name, creator: 'TCO Vereinsportal' });
    this.p.newPage();
  }
  platz(bedarf: number) {
    if (this.y + bedarf > 274) { this.p.newPage(); this.y = 20; }
  }
  kopfband(titel: string, zeile: string) {
    const p = this.p;
    p.rect(0, 0, 210, 46, { fill: C.orange });
    let s = 21;
    while (s > 14 && p.textWidth(titel, { size: s }) > 112) s -= 0.5;
    p.text(LEFT, 31, titel, { size: s, color: 'FFFFFF' });
    p.text(LEFT, 38.5, zeile, { size: 10, color: 'FFFFFF' });
    p.image(logoWeiss(this.v), 137, 5.6, 57, 34.7);
  }
  ueberschrift(t: string) {
    this.y += 4;
    this.p.text(LEFT, this.y, t.toUpperCase(), { size: 8, bold: true, color: C.orangeDk });
    this.y += 3;
  }
  absaetze(absaetze: string[], color = C.ink, breite = 174) {
    for (const a of absaetze) {
      for (const z of umbruch(this.p, a, 9, breite)) {
        this.platz(5);
        this.y += 4.3;
        this.p.text(LEFT, this.y, z, { size: 9, color });
      }
      this.y += 1.8;
    }
  }
  karte(zeilen: Feld[][]) {
    const p = this.p;
    const top = this.y;
    let y = top + 6;
    zeilen.forEach((felder, i) => {
      for (const f of felder) {
        p.text(f.x, y, f.label, { size: 7, color: C.grau });
        p.text(f.x, y + 4.5, kuerzen(p, f.wert || '–', 9, f.w), { size: 9, color: C.ink });
      }
      if (i < zeilen.length - 1) p.line(22, y + 7, 188, y + 7, C.linie, 0.25);
      y += 10.5;
    });
    const h = y - 2.5 - top;
    p.rect(LEFT, top, 174, h, { stroke: C.rand, lw: 0.3, radius: 3 });
    this.y = top + h;
  }
  tabelle(kopf: { x: number; t: string; r?: boolean }[], zeilen: { werte: { x: number; t: string; w?: number; r?: boolean }[]; trenner?: boolean }[], leerText: string) {
    const p = this.p;
    const kopfZeichnen = () => {
      const top = this.y;
      for (const k of kopf) p.text(k.x, top + 7, k.t, { size: 7, color: C.grau, align: k.r ? 'R' : 'L' });
      p.line(22, top + 9.6, 188, top + 9.6, C.linie, 0.3);
      return { top, y: top + 15.5 };
    };
    let { top, y } = kopfZeichnen();
    if (!zeilen.length) {
      p.text(34, y, leerText, { size: 9, color: C.grau });
      y += 7;
    }
    zeilen.forEach((z, i) => {
      if (y > 270) {
        p.rect(LEFT, top, 174, y - 4.4 - top, { stroke: C.rand, lw: 0.3, radius: 3 });
        p.newPage();
        this.y = 20;
        ({ top, y } = kopfZeichnen());
      }
      for (const w of z.werte) p.text(w.x, y, w.w ? kuerzen(p, w.t, 9, w.w) : w.t, { size: 9, color: C.ink, align: w.r ? 'R' : 'L' });
      if (i < zeilen.length - 1) {
        const stark = !!zeilen[i + 1].trenner;
        p.line(22, y + 2.7, 188, y + 2.7, stark ? C.rand : C.linie, stark ? 0.4 : 0.25);
      }
      y += 7;
    });
    const h = y - 3 - top;
    p.rect(LEFT, top, 174, h, { stroke: C.rand, lw: 0.3, radius: 3 });
    this.y = top + h;
  }
  async fertig() {
    alleFusszeilen(this.p, this.v);
    return this.p.render();
  }
}

export interface Druckdaten {
  m: Record<string, any>;
  kontoinhaber: string;
  mandatsref: string;
  vertraege: Vertrag[];
  personen: { name: string; mitglnrn: string; geburtsdatum: string | null; eintritt: string | null; rolle: string }[];
  zahler: Record<string, any> | null;
  glaeubigerId: string;
}

export async function druckdatenLesen(db: Db, adrnr: string): Promise<Druckdaten> {
  const m = await mitgliedLesen(db, adrnr);
  if (!leer(m.telefon)) m.telefon = m.telefon6;
  const [cfg] = await db`select gl_id from tco.soll_cfg where cfgid = 'TCO'`.catch(() => []);
  const fam = await familieLesen(db, m);
  const [zahler] = m.adrnrkih && m.adrnrkih !== m.adrnr ? await db`select * from tco.mitglieder where adrnr = ${m.adrnrkih}` : [];
  return {
    m,
    kontoinhaber: (await kontoinhaberText(db, m.abwkontoinh, m.adrnrkih)) || condense(`${leer(m.vorname)} ${leer(m.nachname)}`),
    mandatsref: await mandatsref(db, adrnr),
    vertraege: (await vertraegeLesen(db, m)).filter((v) => v.laeuft),
    personen: fam.filter((p) => p.adrnr !== m.adrnr).map((p) => ({ ...p, rolle: p.rolle.startsWith('Abweichender') ? 'Zahler' : 'Familienmitglied' })),
    zahler: zahler ?? null,
    glaeubigerId: leer(cfg?.gl_id) || GLAEUBIGER_ID,
  };
}

export async function unterlagePdf(v: Verein, art: Art, d: Druckdaten, datum = heute()): Promise<Buffer> {
  return art === '5' ? sepaMandat(v, d, datum) : brief(v, art, d, datum);
}

async function brief(v: Verein, art: Exclude<Art, '5'>, d: Druckdaten, datum: string): Promise<Buffer> {
  const { m } = d;
  const b = new Brief(v, ART_TEXT[art]);
  const p = b.p;
  const kuend = art === '4';
  const mnr = leer(m.mitglnrn);
  const name = condense(`${leer(m.anrede)} ${leer(m.vorname)} ${leer(m.nachname)}`);
  const ort = condense(`${leer(m.plz)} ${leer(m.ort)}`);
  b.kopfband(ART_TEXT[art].toUpperCase(), mnr ? `Mitglied Nr. ${mnr} · ${dat(datum)}` : dat(datum));

  const grau = { size: 7, color: C.grau };
  const fett = { size: 9.5, bold: true, color: C.ink };
  p.text(LEFT, 58, 'MITGLIED', grau);
  p.text(66, 58, 'MITGLIEDSNUMMER', grau);
  p.text(104, 58, 'ANSPRECHPARTNER', grau);
  p.text(LEFT, 63, kuerzen(p, name, 9.5, 46), fett);
  p.text(LEFT, 67.5, kuerzen(p, leer(m.strasse), 9, 46), { size: 9, color: C.ink });
  p.text(LEFT, 72, kuerzen(p, ort, 9, 46), { size: 9, color: C.ink });
  p.text(66, 63, mnr || '–', fett);
  const mitAustritt = kuend && !!m.austritt;
  p.text(66, 69.5, mitAustritt ? 'AUSTRITT' : 'EINTRITT', grau);
  p.text(66, 74, datOpt(mitAustritt ? m.austritt : m.eintritt), fett);
  p.text(104, 63, v.ansprechpartner ?? '', fett);

  b.y = 88;
  b.absaetze([`Hallo ${leer(m.vorname)},`]);
  const texte: Record<typeof art, string[]> = {
    1: ['hiermit bestätigen wir den Eingang deines Mitgliedsantrages und möchten dich auf diesem Wege recht herzlich als neues Mitglied im Tennisclub Oberthal begrüßen.',
      'Im Folgenden teilen wir dir mit, welche personenbezogenen Daten wir von dir gespeichert haben, welche Verträge/Mitgliedschaften bestehen und wie diese abgerechnet werden.'],
    2: ['anbei erhältst du eine aktuelle Übersicht über deine bei uns gespeicherten Daten und deine laufenden Verträge.',
      'Sollten sich Angaben geändert haben, gib uns bitte kurz Bescheid.'],
    3: [`hiermit bestätigen wir, dass ${condense(`${leer(m.vorname)} ${leer(m.nachname)}`)}${m.geburtsdatum ? `, geboren am ${dat(m.geburtsdatum)},` : ''} seit dem ${datOpt(m.eintritt)} Mitglied im ${v.name} ist`
      + `${m.austritt ? ` und die Mitgliedschaft zum ${dat(m.austritt)} endet.` : '.'}`,
    'Die Bestätigung dient zur Vorlage bei Arbeitgeber, Krankenkasse oder Verband. Die bestehenden Verträge findest du in der folgenden Übersicht.'],
    4: ['wir bedauern deinen Entschluss, nicht länger Mitglied im TC Oberthal zu sein, und bestätigen dir hiermit den Eingang deiner Kündigung.',
      'Deine Verträge werden zum nächstmöglichen Zeitpunkt gekündigt. Welcher Zeitpunkt das genau ist, kannst du der Vertragsübersicht entnehmen.'],
  };
  b.absaetze(texte[art]);

  b.y += 2;
  b.platz(60);
  b.ueberschrift('Kontaktdaten');
  b.karte([
    [{ x: 23, w: 39, label: 'MITGLIEDSNUMMER', wert: mnr }, { x: 66, w: 39, label: 'ANREDE', wert: leer(m.anrede) },
      { x: 109, w: 39, label: 'VORNAME', wert: leer(m.vorname) }, { x: 152, w: 36, label: 'NAME', wert: leer(m.nachname) }],
    [{ x: 23, w: 82, label: 'STRASSE', wert: leer(m.strasse) }, { x: 109, w: 39, label: 'PLZ / WOHNORT', wert: ort },
      { x: 152, w: 36, label: 'GEBURTSDATUM', wert: datOpt(m.geburtsdatum) }],
    [{ x: 23, w: 39, label: 'TELEFON', wert: leer(m.telefon) }, { x: 66, w: 82, label: 'E-MAIL', wert: leer(m.email) },
      { x: 152, w: 36, label: 'EINTRITT', wert: datOpt(m.eintritt) }],
    [{ x: 23, w: 39, label: 'DATENVERARBEITUNG', wert: jn(m.checkbox1) }, { x: 66, w: 39, label: 'VERW. BILD/NAME', wert: jn(m.checkbox2) }],
  ]);

  if (d.personen.length) {
    b.y += 8;
    b.platz(22 + 7 * d.personen.length);
    b.ueberschrift('Verknüpfte Personen');
    b.tabelle(
      [{ x: 23, t: 'NAME' }, { x: 82, t: 'MITGLIEDSNUMMER' }, { x: 110, t: 'GEBURTSDATUM' }, { x: 134, t: 'EINTRITT' }, { x: 156, t: 'VERKNÜPFUNG' }],
      d.personen.map((x) => ({ werte: [{ x: 23, t: x.name, w: 56 }, { x: 82, t: x.mitglnrn || '–' }, { x: 110, t: datOpt(x.geburtsdatum) },
        { x: 134, t: datOpt(x.eintritt) }, { x: 156, t: x.rolle, w: 32 }] })), '');
  }

  b.y += 8;
  b.platz(34);
  b.ueberschrift('Vertragsdaten');
  const mitPerson = new Set(d.vertraege.map((x) => x.adrnr)).size > 1;
  const xb = mitPerson ? 62 : 34, wb = mitPerson ? 37 : 64;
  let vorher = '';
  b.tabelle(
    [{ x: 23, t: 'POS' }, ...(mitPerson ? [{ x: 34, t: 'FÜR' }] : []), { x: xb, t: 'BESCHREIBUNG' }, { x: 101, t: 'TURNUS' }, { x: 126, t: 'BEGINN' },
      { x: 150, t: 'ENDE' }, { x: 187, t: 'BETRAG', r: true }],
    d.vertraege.map((x, i) => {
      const neuePerson = x.adrnr !== vorher;
      vorher = x.adrnr;
      return {
        trenner: mitPerson && neuePerson && i > 0,
        werte: [
          { x: 23, t: String(i + 1) },
          ...(mitPerson && neuePerson ? [{ x: 34, t: x.person.split(' ')[0], w: 26 }] : []),
          { x: xb, t: x.artname, w: wb }, { x: 101, t: x.sollstellung }, { x: 126, t: datOpt(x.vertragbegin) },
          { x: 150, t: !x.vertragende || x.vertragende === '9999-12-31' ? 'unbefristet' : dat(x.vertragende) },
          { x: 187, t: betragText(x.betrag), r: true },
        ],
      };
    }), 'Es sind keine laufenden Verträge hinterlegt.');

  if (leer(m.iban1) && !kuend && art !== '3') {
    b.y += 8;
    b.platz(58);
    b.ueberschrift('SEPA-Lastschrift');
    b.absaetze([art === '1'
      ? 'Zukünftig werden wir die oben aufgeführten Beiträge mit dem uns vorliegenden SEPA-Mandat mittels SEPA-Lastschrift einziehen.'
      : 'Die oben aufgeführten Beiträge ziehen wir mit dem uns vorliegenden SEPA-Mandat mittels SEPA-Lastschrift ein.']);
    b.y += 1;
    sepaKarte(b, d);
    b.y += 5;
    b.platz(20);
    b.absaetze([
      'Die fälligen Beiträge ziehen wir am ersten Arbeitstag des jeweiligen Monats ein (Mitgliedsbeiträge zum 02. Januar bzw. 01. Juli).',
      'Fällt der Fälligkeitstag auf ein Wochenende oder einen Feiertag, verschiebt er sich auf den folgenden Werktag.',
    ]);
  }
  if (!kuend && art !== '3') {
    b.y += 6;
    b.platz(40);
    b.ueberschrift('Kündigungsfristen');
    b.absaetze([
      'Die Mitgliedschaft im TC Oberthal kann nur zum Jahresende gekündigt werden.',
      'Die Teilnahme am Jugendtraining ist jeweils zum 30.09. eines jeden Jahres kündbar. Wird nicht rechtzeitig gekündigt, verlängert sich der Vertrag automatisch um ein weiteres Jahr.',
      'Die Kündigungsfrist beträgt bei allen Verträgen 4 Wochen. Die Kündigung ist schriftlich (per E-Mail oder Brief) gegenüber einem Vorstandsmitglied zu erklären.',
    ]);
  }
  b.y += 3;
  b.platz(18);
  b.absaetze([{ 1: 'Wir freuen uns auf dich - viel Spaß beim Tennis!', 2: 'Bei Fragen sind wir gerne für dich da.', 3: 'Bei Fragen sind wir gerne für dich da.',
    4: 'Wir wünschen dir für die Zukunft alles erdenklich Gute.' }[art]]);
  p.text(LEFT, b.y + 5, 'Mit sportlichen Grüßen', { size: 9, color: C.ink });
  p.text(LEFT, b.y + 9.3, v.ansprechpartner ?? '', { size: 9, color: C.ink });
  return b.fertig();
}

function sepaKarte(b: Brief, d: Druckdaten) {
  const p = b.p;
  const y = b.y;
  p.rect(LEFT, y, 174, 38, { fill: 'FFFFFF', radius: 3 });
  p.rect(LEFT, y, 174, 11, { fill: C.orangeSoft, radius: 3 });
  p.rect(LEFT, y + 6, 174, 5, { fill: C.orangeSoft });
  p.rect(LEFT, y, 174, 38, { stroke: C.orange, lw: 0.45, radius: 3 });
  p.text(23, y + 7.3, 'SEPA-LASTSCHRIFTMANDAT', { size: 8, bold: true, color: C.orangeDk });
  p.text(187, y + 7.3, `Gläubiger-ID ${d.glaeubigerId}`, { size: 8, bold: true, color: C.orangeDk, align: 'R' });
  const f: Feld[] = [
    { x: 23, w: 80, label: 'KONTOINHABER', wert: d.kontoinhaber }, { x: 109, w: 78, label: 'MANDATSREFERENZ', wert: d.mandatsref },
    { x: 23, w: 80, label: 'IBAN', wert: ibanFormat(d.m.iban1) }, { x: 109, w: 36, label: 'BIC', wert: leer(d.m.bic1) },
    { x: 152, w: 36, label: 'FÜR', wert: condense(`${leer(d.m.vorname)} ${leer(d.m.nachname)}`) },
  ];
  f.forEach((x, i) => {
    const yy = y + (i < 2 ? 17 : 29);
    p.text(x.x, yy, x.label, { size: 7, color: C.grau });
    p.text(x.x, yy + 4.5, kuerzen(p, x.wert || '–', 9.5, x.w), { size: 9.5, bold: true, color: C.ink });
  });
  b.y = y + 38;
}

async function sepaMandat(v: Verein, d: Druckdaten, datum: string): Promise<Buffer> {
  const { m, zahler } = d;
  const b = new Brief(v, ART_TEXT[5]);
  const p = b.p;
  let str = leer(m.strasse), ort = condense(`${leer(m.plz)} ${leer(m.ort)}`);
  let iban = leer(m.iban1), bic = leer(m.bic1), bank = leer(m.bank1);
  if (zahler) {
    if (leer(zahler.strasse) || leer(zahler.ort)) { str = leer(zahler.strasse); ort = condense(`${leer(zahler.plz)} ${leer(zahler.ort)}`); }
    if (leer(zahler.iban1)) { iban = leer(zahler.iban1); bic = leer(zahler.bic1); bank = leer(zahler.bank1); }
  }
  b.kopfband('SEPA-LASTSCHRIFTMANDAT', `Mandatsreferenz ${d.mandatsref || '–'} · ${dat(datum)}`);
  b.y = 54;
  b.ueberschrift('Zahlungsempfänger');
  b.y += 1;
  b.karte([
    [{ x: 23, w: 82, label: 'NAME', wert: v.name }, { x: 109, w: 79, label: 'GLÄUBIGER-IDENTIFIKATIONSNUMMER', wert: d.glaeubigerId }],
    [{ x: 23, w: 82, label: 'ANSCHRIFT', wert: `${v.strasse ?? ''}, ${v.plz_ort ?? ''}` }, { x: 109, w: 79, label: 'MANDATSREFERENZ', wert: d.mandatsref }],
  ]);
  b.y += 4;
  b.ueberschrift('Mitglied und Zahlungsart');
  b.y += 1;
  b.karte([
    [{ x: 23, w: 82, label: 'MITGLIED', wert: condense(`${leer(m.vorname)} ${leer(m.nachname)}`) }, { x: 109, w: 36, label: 'MITGLIEDSNUMMER', wert: leer(m.mitglnrn) },
      { x: 152, w: 36, label: 'ZAHLUNGSART', wert: 'Wiederkehrend' }],
    [{ x: 23, w: 165, label: 'VERWENDUNG', wert: 'Mitgliedsbeiträge, Trainingsgebühren und sonstige Forderungen des Vereins' }],
  ]);
  b.y += 4;
  b.ueberschrift('Ermächtigung');
  b.absaetze([
    `Ich ermächtige den ${v.name}, Zahlungen von meinem Konto mittels Lastschrift einzuziehen. Zugleich weise ich mein Kreditinstitut an, die vom ${v.name} auf mein Konto gezogenen Lastschriften einzulösen.`,
    'Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen. Es gelten dabei die mit meinem Kreditinstitut vereinbarten Bedingungen.',
    'Die Vorabankündigung (Pre-Notification) über Betrag und Fälligkeit erfolgt spätestens fünf Kalendertage vor dem Einzug.',
  ]);
  b.y += 2;
  b.ueberschrift('Kontoinhaber / Zahlungspflichtiger');
  b.y += 1;
  b.karte([
    [{ x: 23, w: 82, label: 'NAME', wert: d.kontoinhaber }, { x: 109, w: 79, label: 'KREDITINSTITUT', wert: bank }],
    [{ x: 23, w: 82, label: 'STRASSE', wert: str }, { x: 109, w: 79, label: 'PLZ / ORT', wert: ort }],
    [{ x: 23, w: 82, label: 'IBAN', wert: ibanFormat(iban) }, { x: 109, w: 79, label: 'BIC', wert: bic }],
  ]);
  b.platz(32);
  const y = b.y + 24;
  p.line(LEFT, y, 95, y, C.ink, 0.3);
  p.line(110, y, 192, y, C.ink, 0.3);
  p.text(LEFT, y + 4.5, 'Ort, Datum', { size: 7, color: C.grau });
  p.text(110, y + 4.5, 'Unterschrift Kontoinhaber/in', { size: 7, color: C.grau });
  return b.fertig();
}
