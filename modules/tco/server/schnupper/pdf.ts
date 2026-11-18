import { heute } from '../format.js';
import { C, fusszeile, kuerzen, LEFT, umbruch } from '../pdf/layout.js';
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { logoWeiss, type Db, type Verein } from '../verein.js';
import { Abschlussdruck } from '../abschluss/pdf.js';
import { EINHEITEN_KOSTENLOS, schnupperLesen, type SchnupperZeile } from './logik.js';
import { berichtAbschnitte, datumText, einheitenZeilen, LISTE_SPALTEN, listenEintrag, zeitpunktText, type BerichtZusatz } from './bericht.js';

/**
 * Schnuppertraining (#86) – Bericht zum Ausdrucken im TCO-Layout (Kopfband mit Logo, Kennzahlen, Karten, Folgekopf,
 * Fußzeile; Bausteine aus abschluss/pdf.ts): je Anmeldung eine eigene Seite mit allen Angaben des Schnupperantrags
 * und der Betreuung in Tabellenform sowie den eingetragenen Einheiten.
 */

const X = { angabe: 24, inhalt: 80, datum: 24, trainer: 60, erfasst: 130 };
const B = { angabe: 54, inhalt: 108 };

class Schnupperdruck extends Abschlussdruck {
  constructor(v: Verein, titel: string) { super(v, Number(heute().slice(0, 4)), titel); }

  anmeldung(z: SchnupperZeile, x: BerichtZusatz) {
    const name = `${z.vorname} ${z.nachname}`.trim();
    this.teilBeginnen(`Schnuppertraining ${z.nummer} – ${name}`);
    this.kopfband('SCHNUPPERTRAINING', this.kurz(`Anmeldung ${z.nummer} · ${name}`, 112, 10));
    this.kennzahl(LEFT, 'ANMELDUNG', z.nummer);
    this.kennzahl(62, 'EINGANG', zeitpunktText(z.eingang).replace(' Uhr', ''));
    this.kennzahl(112, 'STATUS', this.kurz(z.status_txt, 44, 9.5));
    this.kennzahl(160, 'EINHEITEN', `${z.einheiten} von ${EINHEITEN_KOSTENLOS}`, z.einheiten > EINHEITEN_KOSTENLOS ? 'B3261E' : C.ink);

    for (const a of berichtAbschnitte(z, x, EINHEITEN_KOSTENLOS)) {
      this.karteBeginnen(a.titel, [{ x: X.angabe, text: 'Angabe', align: 'L' }, { x: X.inhalt, text: 'Inhalt', align: 'L' }]);
      for (const [angabe, inhalt] of a.zeilen) {
        const links = umbruch(this.p, angabe, 8, B.angabe);
        const rechts = inhalt.split(/\r?\n/).flatMap((t) => (t.trim() ? umbruch(this.p, t, 8, B.inhalt) : ['']));
        const n = Math.max(links.length, rechts.length);
        const hoehe = 5.6 + (n - 1) * 4;
        this.zeilePlatz(hoehe);
        const y0 = this.y;
        links.forEach((t, j) => this.p.text(X.angabe, y0 + j * 4, t, { size: 8, color: C.grau }));
        rechts.forEach((t, j) => this.p.text(X.inhalt, y0 + j * 4, t, { size: 8, color: C.ink, bold: angabe === 'Status' }));
        this.y = y0 + hoehe - 5.6;
        this.zeileLinie();
      }
      this.karteBeenden();
    }

    const einheiten = einheitenZeilen(x);
    this.karteBeginnen('Eingetragene Einheiten (Meine Trainingszeiten)', [
      { x: X.datum, text: 'Datum', align: 'L' }, { x: X.trainer, text: 'Trainer', align: 'L' }, { x: X.erfasst, text: 'Erfasst von', align: 'L' },
    ]);
    if (!einheiten.length) { this.txt(X.datum, 'Noch keine Einheit eingetragen.', { color: C.grau }); this.zeileLinie(); }
    for (const [d, t, e] of einheiten) {
      this.zeilePlatz();
      this.txt(X.datum, d);
      this.txt(X.trainer, this.kurz(t, 66));
      this.txt(X.erfasst, this.kurz(e, 58));
      this.zeileLinie();
    }
    this.karteBeenden(`Stand ${datumText(heute())} · Die Kontaktdaten dürfen nur für die Kontaktaufnahme zum Schnuppertraining genutzt werden. `
      + 'Bericht vertraulich behandeln und nach Gebrauch vernichten.');
  }
}

/** Zusatzangaben je Anmeldung: Einwilligung und eingetragene Einheiten mit Trainernamen */
async function zusatzLesen(db: Db, adrnrs: string[]): Promise<Map<string, BerichtZusatz>> {
  const m = new Map<string, BerichtZusatz>(adrnrs.map((a) => [a, { einwilligung_am: null, einheiten: [] }]));
  if (!adrnrs.length) return m;
  for (const r of await db`select adrnr, einwilligung_am from tco.schnupper where adrnr = any(${adrnrs})`) {
    m.get(r.adrnr)!.einwilligung_am = r.einwilligung_am ? new Date(r.einwilligung_am).toISOString() : null;
  }
  for (const r of await db`
    select e.schnupper_adrnr as adrnr, e.datum::text as datum, e.erfasst_von,
           nullif(trim(coalesce(t.vorname, '') || ' ' || coalesce(t.nachname, '')), '') as trainer
      from tco.schnupper_einheiten e left join tco.mitglieder t on t.adrnr = e.trainer_adrnr
     where e.schnupper_adrnr = any(${adrnrs})`) {
    m.get(r.adrnr)!.einheiten.push({ datum: r.datum, trainer: r.trainer, erfasst_von: r.erfasst_von });
  }
  return m;
}

/**
 * Bericht als PDF: die Anmeldungen `adrnrs` (Reihenfolge wie in der Verwaltung) oder – ohne Auswahl – alle der Liste
 * `filter` (offen bzw. alle). Unbekannte Nummern werden übergangen; ist danach nichts übrig, null.
 */
export async function schnupperPdf(db: Db, v: Verein, o: { filter: 'OFFEN' | 'ALLE'; adrnrs?: string[] }): Promise<{ pdf: Buffer; titel: string } | null> {
  const alle = await schnupperLesen(db, o.adrnrs?.length ? 'ALLE' : o.filter);
  const zeilen = o.adrnrs?.length ? alle.filter((z) => o.adrnrs!.includes(z.adrnr)) : alle;
  if (!zeilen.length) return null;
  const titel = zeilen.length === 1
    ? `Schnuppertraining ${zeilen[0].nummer} ${zeilen[0].vorname} ${zeilen[0].nachname}`.trim()
    : `Schnuppertraining – ${zeilen.length} Anmeldungen (${o.filter === 'ALLE' && !o.adrnrs?.length ? 'alle' : o.adrnrs?.length ? 'Auswahl' : 'offen'}) ${datumText(heute())}`;
  const zusatz = await zusatzLesen(db, zeilen.map((z) => z.adrnr));
  const d = new Schnupperdruck(v, titel);
  for (const z of zeilen) d.anmeldung(z, zusatz.get(z.adrnr)!);
  return { pdf: await d.render(), titel };
}

// ---------------------------------------------------------------------------- Liste im Querformat
/**
 * Kompakte Liste zum Ausdrucken (A4 quer, TCO-Layout): je Interessent ein paar Zeilen in fünf Spalten – Anmeldung,
 * Interessent, Kontakt, Tennis und Wunschtermine, Stand und Betreuung –, darunter Mitteilung und Notiz.
 */
const Q = { breite: 297, hoehe: 210, rechts: 279, unten: 186, oben: 24 };
const LX = [LEFT, 50, 106, 162, 219];
const LB = [30, 54, 54, 55, 60];
const ZH = 3.7;  // Zeilenhöhe

export async function schnupperListePdf(db: Db, v: Verein, o: { filter: 'OFFEN' | 'ALLE'; adrnrs?: string[] }): Promise<{ pdf: Buffer; titel: string } | null> {
  const alle = await schnupperLesen(db, o.adrnrs?.length ? 'ALLE' : o.filter);
  const zeilen = o.adrnrs?.length ? alle.filter((z) => o.adrnrs!.includes(z.adrnr)) : alle;
  if (!zeilen.length) return null;
  const art = o.adrnrs?.length ? 'Auswahl' : o.filter === 'ALLE' ? 'alle Anmeldungen' : 'offene Anmeldungen';
  const titel = `Schnuppertraining – Interessenten (${art}) ${datumText(heute())}`;
  const p = new Pdf({ title: titel, author: v.name, creator: 'TCO Vereinsportal' });
  let y = 0;

  const spaltenkopf = () => {
    LISTE_SPALTEN.forEach((t, i) => p.text(LX[i], y, t.toUpperCase(), { size: 6.5, bold: true, color: C.grau }));
    p.line(LEFT, y + 2, Q.rechts, y + 2, C.orange, 0.4);
    y += 6.5;
  };
  const neueSeite = (erste: boolean) => {
    p.newPage(true);
    if (erste) {
      p.rect(0, 0, Q.breite, 30, { fill: C.orange });
      p.text(LEFT, 16, 'SCHNUPPERTRAINING – INTERESSENTEN', { size: 18, color: 'FFFFFF' });
      p.text(LEFT, 23.5, `${zeilen.length} ${zeilen.length === 1 ? 'Anmeldung' : 'Anmeldungen'} (${art}) · Stand ${datumText(heute())}`, { size: 9, color: 'FFFFFF' });
      p.image(logoWeiss(v), Q.rechts - 37, 3.5, 37, 22.5);
      y = 40;
    } else {
      p.text(LEFT, 13, 'Schnuppertraining – Interessenten', { size: 9, bold: true, color: C.ink });
      p.text(Q.rechts, 13, v.name, { size: 8, color: C.grau, align: 'R' });
      p.rect(LEFT, 15.5, Q.rechts - LEFT, 0.6, { fill: C.orange });
      y = Q.oben;
    }
    spaltenkopf();
  };

  neueSeite(true);
  zeilen.forEach((z, n) => {
    const e = listenEintrag(z, EINHEITEN_KOSTENLOS);
    // je Spalte höchstens drei Zeilen (lange Angaben umbrochen und gekürzt), Bemerkung höchstens zwei Zeilen über die volle Breite
    const spalten = e.spalten.map((zz, i) => zz.flatMap((t) => umbruch(p, t, 8, LB[i])).slice(0, 3).map((t) => kuerzen(p, t, 8, LB[i])));
    const bem = e.bemerkung ? umbruch(p, e.bemerkung, 7, Q.rechts - LEFT - 4).slice(0, 2) : [];
    const hoehe = Math.max(...spalten.map((x) => x.length), 1) * ZH + bem.length * 3.3 + 3;
    if (y + hoehe > Q.unten) neueSeite(false);
    if (n % 2 === 1) p.rect(LEFT - 1, y - 3.6, Q.rechts - LEFT + 2, hoehe, { fill: C.orangeSoft, radius: 1 });
    spalten.forEach((zz, i) => zz.forEach((t, j) => p.text(LX[i], y + j * ZH, t, {
      size: 8, color: j === 0 ? C.ink : C.grau, bold: j === 0 && (i === 1 || (i === 4)),
    })));
    const yb = y + Math.max(...spalten.map((x) => x.length), 1) * ZH;
    bem.forEach((t, j) => p.text(LX[1], yb + j * 3.3, t, { size: 7, color: C.orangeDk }));
    y += hoehe;
    p.line(LEFT, y - 3.4, Q.rechts, y - 3.4, C.linie, 0.2);
  });
  const anzahl = p.pageCount();
  for (let i = 0; i < anzahl; i++) { p.setPage(i); fusszeile(p, v, i + 1, anzahl, true); }
  // Hinweis zur Vertraulichkeit auf der letzten Seite
  p.setPage(anzahl - 1);
  p.text(LEFT, Q.hoehe - 20, 'Kontaktdaten nur für die Kontaktaufnahme zum Schnuppertraining nutzen · vertraulich behandeln und nach Gebrauch vernichten.', { size: 6.5, color: C.grau });
  return { pdf: await p.render(), titel };
}
