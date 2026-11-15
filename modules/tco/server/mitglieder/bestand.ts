import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { leer } from './logik.js';

/**
 * LSVS-Bestandsmeldung: Austauschdatei für das LSVSnet nach der DOSB-Schnittstelle „SV-LSB“
 * (Schnittstelle Bestandsdaten, Version 1.2): Anzahl je Geburtsjahrgang und Geschlecht,
 * Typ A = alle Mitglieder, Typ B = je Fachverband. TC Oberthal ist ein reiner Tennisverein,
 * daher stehen in der B-Meldung dieselben Zahlen unter dem Fachverband Tennis.
 *
 * Gezählt wird, wer am Stichtag Mitglied ist: Eintritt am oder vor dem Stichtag, kein Austritt
 * oder Austritt am oder nach dem Stichtag (eine Kündigung zum 31.12. zählt zum 01.01. also nicht mehr).
 * Ohne Geburtsdatum oder Geschlecht lässt sich ein Mitglied nicht zuordnen – es fehlt in der Datei und
 * erscheint als Hinweis, damit die Stammdaten vor dem Hochladen ergänzt werden.
 */

export interface BestandMitglied {
  adrnr: string; vorname: string | null; nachname: string | null; geschlecht: string | null;
  geburtsdatum: string | null; eintritt: string | null; austritt: string | null;
}
export interface BestandKopf { schluessel: string; nummer: string; bezeichnung: string; ansprechpartner: string; fachverband: string }
export interface BestandZeile { jahrgang: number; m: number; w: number; d: number }
export interface BestandHinweis { adrnr: string; name: string; grund: string }
export interface Bestand {
  stichtag: string; kopf: BestandKopf; zeilen: BestandZeile[];
  summe: { m: number; w: number; d: number; gesamt: number }; hinweise: BestandHinweis[]; fehlt: string[];
}

/** Geschlecht aus dem Mitgliederstamm (SAP: 1 männlich, 2 weiblich; divers als 3 oder D) */
export function geschlechtLsvs(g: string | null | undefined): 'm' | 'w' | 'd' | null {
  const x = leer(g).toUpperCase();
  if (x === '1' || x === 'M') return 'm';
  if (x === '2' || x === 'W' || x === 'F') return 'w';
  if (x === '3' || x === 'D' || x === 'X') return 'd';
  return null;
}

export const stichtagStandard = (heute: string) => {
  // bis Ende Januar die laufende Meldung (01.01. dieses Jahres), danach die kommende
  const jahr = Number(heute.slice(0, 4));
  return heute.slice(5, 7) === '01' ? `${jahr}-01-01` : `${jahr + 1}-01-01`;
};

export function bestandErmitteln(mitglieder: BestandMitglied[], kopf: BestandKopf, stichtag: string): Bestand {
  const je = new Map<number, BestandZeile>();
  const hinweise: BestandHinweis[] = [];
  for (const x of mitglieder) {
    if (!x.eintritt || x.eintritt > stichtag) continue;
    if (x.austritt && x.austritt < stichtag) continue;
    const name = [leer(x.nachname), leer(x.vorname)].filter(Boolean).join(', ') || x.adrnr;
    const g = geschlechtLsvs(x.geschlecht);
    const jahrgang = x.geburtsdatum ? Number(x.geburtsdatum.slice(0, 4)) : NaN;
    const gruende = [!x.geburtsdatum || !(jahrgang > 1850) ? 'Geburtsdatum fehlt' : '', !g ? 'Geschlecht fehlt' : ''].filter(Boolean);
    if (gruende.length) { hinweise.push({ adrnr: x.adrnr, name, grund: gruende.join(', ') }); continue; }
    const z = je.get(jahrgang) ?? { jahrgang, m: 0, w: 0, d: 0 };
    z[g!] += 1;
    je.set(jahrgang, z);
  }
  const zeilen = [...je.values()].sort((a, b) => a.jahrgang - b.jahrgang);
  const summe = zeilen.reduce((s, z) => ({ m: s.m + z.m, w: s.w + z.w, d: s.d + z.d, gesamt: s.gesamt + z.m + z.w + z.d }), { m: 0, w: 0, d: 0, gesamt: 0 });
  const fehlt = [
    !kopf.nummer ? 'Vereinsnummer beim LSVS' : '', !kopf.fachverband ? 'Fachverbandscode Tennis' : '',
    !kopf.ansprechpartner ? 'Ansprechpartner' : '', !kopf.schluessel ? 'Software-Schlüssel' : '',
  ].filter(Boolean);
  hinweise.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { stichtag, kopf, zeilen, summe, hinweise, fehlt };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const el = (name: string, wert: string | number, tiefe: number) => `${'  '.repeat(tiefe)}<${name}>${esc(String(wert))}</${name}>`;

/** XML nach Schnittstelle „SV-LSB“: je Jahrgang ein Block Typ A und ein Block Typ B (Fachverband Tennis) */
export function bestandXml(b: Bestand): string {
  const zahlen = (typ: 'A' | 'B', z: BestandZeile) => [
    '  <Zahlen>', el('Typ', typ, 2), typ === 'A' ? '    <Fachverband></Fachverband>' : el('Fachverband', b.kopf.fachverband, 2),
    el('Jahrgang', z.jahrgang, 2), el('AnzahlM', z.m, 2), el('AnzahlW', z.w, 2), el('AnzahlD', z.d, 2), '  </Zahlen>',
  ];
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<Mitglieder>',
    '  <Software>', el('Schluessel', b.kopf.schluessel, 2), '  </Software>',
    '  <Verein>', el('Nummer', b.kopf.nummer, 2), el('Bezeichnung', b.kopf.bezeichnung, 2), el('Ansprechpartner', b.kopf.ansprechpartner, 2), '  </Verein>',
    ...b.zeilen.flatMap((z) => zahlen('A', z)),
    ...b.zeilen.flatMap((z) => zahlen('B', z)),
    '</Mitglieder>',
    '',
  ].join('\n');
}

export async function bestandLesen(db: Db, stichtag: string): Promise<Bestand> {
  const [v] = await db`select name, lsvs_vereinsnr, lsvs_ansprechpartner, lsvs_fachverband, lsvs_schluessel from tco.verein where id = 1`;
  const m = await db`select adrnr, vorname, nachname, geschlecht, geburtsdatum::text as geburtsdatum, eintritt::text as eintritt, austritt::text as austritt
                       from tco.mitglieder where eintritt is not null`;
  const t = (s: unknown) => leer(s as string).trim();
  return bestandErmitteln(m as unknown as BestandMitglied[], {
    schluessel: t(v?.lsvs_schluessel), nummer: t(v?.lsvs_vereinsnr), bezeichnung: t(v?.name),
    ansprechpartner: t(v?.lsvs_ansprechpartner), fachverband: t(v?.lsvs_fachverband),
  }, stichtag);
}

/** Datei nur mit vollständigem Kopf – sonst lehnt das LSVSnet sie ab */
export function bestandPruefen(b: Bestand) {
  if (b.fehlt.length) throw new BusinessError(`Für die Bestandsmeldung fehlt unter Einstellungen → TC Oberthal → Verein und Bank: ${b.fehlt.join(', ')}.`);
  if (!b.summe.gesamt) throw new BusinessError('Zum Stichtag gibt es keine Mitglieder mit Geburtsdatum und Geschlecht.');
}
