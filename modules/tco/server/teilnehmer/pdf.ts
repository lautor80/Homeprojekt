import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { logoWeiss, type Verein } from '../verein.js';
import { dat, heute, runden } from '../format.js';
import { betragText, C, kuerzen, LEFT, RIGHT } from '../pdf/layout.js';
import type { Teilnehmer } from './logik.js';

/** Auswahl, wie sie die App anzeigt (Filter, Suche, markierte Teilnehmer) */
export interface TeilnehmerAuswahl {
  filter: 'ALL' | 'MEMBER' | 'NONMEMBER';
  suche: string;
  /** nur diese Personen (Markierung in der App); leer = alle der Trefferliste */
  adrnrs: string[];
}

export const FILTER_TEXT: Record<TeilnehmerAuswahl['filter'], string> = { ALL: 'Alle Teilnehmer', MEMBER: 'Nur Vereinsmitglieder', NONMEMBER: 'Nur Nichtmitglieder' };

/** Dieselbe Filterlogik wie die Oberfläche (Teilnehmer.tsx) */
export function auswaehlen(alle: Teilnehmer[], a: TeilnehmerAuswahl): Teilnehmer[] {
  const s = a.suche.trim().toUpperCase();
  const markiert = new Set(a.adrnrs);
  return alle
    .filter((t) => (a.filter === 'MEMBER' ? t.mitglied : a.filter === 'NONMEMBER' ? !t.mitglied : true))
    .filter((t) => !s || t.name.toUpperCase().includes(s) || t.email.toUpperCase().includes(s))
    .filter((t) => !markiert.size || markiert.has(t.adrnr));
}

export const teilnehmerTitel = (stichtag = heute()) => `${stichtag.replace(/-/g, '_')}_TCO_TEILNEHMER_JUGENDTRAINING`;

/**
 * Teilnehmerliste Jugendtraining im Vereinslayout: Kopfband mit Logo, Auswahl und Stand,
 * Kennzahlen, Tabelle (Name, Geburtsdatum/Alter, E-Mail, Einheiten, Trainingsbeitrag, Mitglied)
 * mit Summenzeile und Vereinsfußzeile. Interne Liste – ohne Bankverbindung des Vereins.
 */
export async function teilnehmerPdf(v: Verein, rows: Teilnehmer[], a: TeilnehmerAuswahl, stichtag = heute()): Promise<Buffer> {
  const p = new Pdf({ title: teilnehmerTitel(stichtag), author: v.name, creator: 'TCO Vereinsportal' });
  p.newPage();
  const grau = { size: 7, color: C.grau };
  const normal = { size: 8, color: C.ink };

  // ---- Kopfband
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 27, 'TEILNEHMER', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 35, 'JUGENDTRAINING', { size: 13, color: 'FFFFFF' });
  p.text(LEFT, 41.5, `Stand ${dat(stichtag)} · Personen mit laufendem Jugendtraining-Vertrag`, { size: 8.5, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  // ---- Auswahl
  const auswahl = [
    FILTER_TEXT[a.filter],
    a.suche.trim() && `Suche „${a.suche.trim()}“`,
    a.adrnrs.length > 0 && `${a.adrnrs.length} markierte Person(en)`,
  ].filter(Boolean).join(' · ');
  p.text(LEFT, 56, 'AUSWAHL', grau);
  p.text(LEFT, 61, auswahl, { size: 9.5, bold: true, color: C.ink });

  // ---- Kennzahlen
  const einheiten = rows.reduce((s, t) => s + t.einheiten, 0);
  const beitrag = runden(rows.reduce((s, t) => s + t.trainingsbeitrag, 0));
  const mitglieder = rows.filter((t) => t.mitglied).length;
  let y = 67;
  p.rect(LEFT, y, 174, 18, { fill: C.orangeSoft, radius: 3 });
  const kpis: [string, string][] = [
    ['TEILNEHMER', String(rows.length)], ['MITGLIEDER', String(mitglieder)], ['NICHTMITGLIEDER', String(rows.length - mitglieder)],
    ['EINHEITEN', String(einheiten)], ['TRAININGSBEITRÄGE', betragText(beitrag)],
  ];
  const breite = 174 / kpis.length;
  kpis.forEach(([l, w], i) => {
    p.text(LEFT + 5 + i * breite, y + 7, l, { size: 6.5, bold: true, color: C.orangeDk });
    p.text(LEFT + 5 + i * breite, y + 13.5, w, { size: 11.5, bold: true, color: C.ink });
  });
  y += 27;

  // ---- Tabelle
  const sp = { nr: LEFT, name: LEFT + 8, geb: LEFT + 64, alter: LEFT + 90, mail: LEFT + 95, einh: LEFT + 145, betrag: LEFT + 162, mitgl: RIGHT };
  const kopfzeile = () => {
    p.text(LEFT, y, 'TEILNEHMERLISTE', { size: 8, bold: true, color: C.orangeDk });
    y += 6;
    p.text(sp.nr, y, '#', grau);
    p.text(sp.name, y, 'NAME', grau);
    p.text(sp.geb, y, 'GEBURTSDATUM', grau);
    p.text(sp.alter, y, 'ALTER', { ...grau, align: 'R' });
    p.text(sp.mail, y, 'E-MAIL', grau);
    p.text(sp.einh, y, 'EINH.', { ...grau, align: 'R' });
    p.text(sp.betrag, y, 'BEITRAG', { ...grau, align: 'R' });
    p.text(sp.mitgl, y, 'MITGLIED', { ...grau, align: 'R' });
    y += 2;
    p.line(LEFT, y, RIGHT, y, C.linie, 0.3);
    y += 4.5;
  };
  kopfzeile();
  if (!rows.length) {
    p.text(LEFT, y + 2, 'Keine Teilnehmer in der Auswahl.', { size: 9, color: C.grau });
    y += 8;
  }
  rows.forEach((t, i) => {
    if (y > 266) { p.newPage(); y = 18; kopfzeile(); }
    if (i % 2 === 1) p.rect(LEFT - 1, y - 3.4, 176, 4.8, { fill: C.fuss });
    p.text(sp.nr, y, String(i + 1), { size: 7.5, color: C.grau });
    p.text(sp.name, y, kuerzen(p, t.name, 8, 54), { size: 8, bold: true, color: C.ink });
    p.text(sp.geb, y, t.geburtsdatum ? dat(t.geburtsdatum) : '–', normal);
    p.text(sp.alter, y, t.alter === null ? '' : String(t.alter), { ...normal, align: 'R' });
    p.text(sp.mail, y, kuerzen(p, t.email || '–', 8, 46), { size: 8, color: t.email ? C.ink : C.grau });
    p.text(sp.einh, y, String(t.einheiten), { size: 8, bold: true, color: C.ink, align: 'R' });
    p.text(sp.betrag, y, betragText(t.trainingsbeitrag), { ...normal, align: 'R' });
    p.text(sp.mitgl, y, t.mitglied ? 'Ja' : 'Nein', { size: 8, bold: true, color: t.mitglied ? '256F3A' : C.orangeDk, align: 'R' });
    y += 4.8;
  });

  // ---- Summenzeile
  if (y > 262) { p.newPage(); y = 18; }
  y += 0.5;
  p.line(LEFT, y, RIGHT, y, C.ink, 0.4);
  y += 5;
  p.text(sp.name, y, `Summe (${rows.length} Teilnehmer)`, { size: 8.5, bold: true, color: C.ink });
  p.text(sp.einh, y, String(einheiten), { size: 8.5, bold: true, color: C.ink, align: 'R' });
  p.text(sp.betrag, y, betragText(beitrag), { size: 8.5, bold: true, color: C.ink, align: 'R' });
  y += 9;
  if (y > 270) { p.newPage(); y = 18; }
  p.text(LEFT, y, 'Jeder laufende Vertrag der Art 90 (Jugendtraining) zählt als Einheit; Trainingsbeitrag = Summe dieser Verträge je Turnus.', grau);
  p.text(LEFT, y + 4, 'Ein laufender Vertrag einer Art unter 90 macht die Person zum Vereinsmitglied. Enthält personenbezogene Daten – nur für den internen Gebrauch.', grau);

  // ---- Fußzeilen (interne Liste, ohne Vereins-IBAN)
  const n = p.pageCount();
  for (let i = 0; i < n; i++) {
    p.setPage(i);
    p.rect(0, 282, 210, 15, { fill: C.fuss });
    p.rect(0, 281.2, 210, 1, { fill: C.orange });
    p.text(LEFT, 290.5, `${v.name} · Teilnehmer Jugendtraining · Stand ${dat(stichtag)}`, { size: 7, color: C.grau });
    p.text(RIGHT, 290.5, `Seite ${i + 1} von ${n}`, { size: 7, color: C.grau, align: 'R' });
  }
  return p.render();
}
