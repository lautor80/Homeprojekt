import { BusinessError } from '../../../server/src/errors.js';
import { PH, PH_DOKID, type KontextDef } from '../../../server/src/lib/paperless-mapping.js';
import type { Paperless } from '../../../server/src/lib/paperless.js';
import { paperlessDef, paperlessFuer } from '../../../server/src/lib/verbindungen.js';

/** Anbindung „Paperless-ngx Vermietung“ – eigener Zugang je Bereich (#232, S5), gepflegt unter Administration → Schnittstellen */
export const MIETE_PAPERLESS = paperlessDef('miete', 'Vermietung');

/** Ablagekontexte für die zentrale Paperless-Zuordnung (Administration → Schnittstellen → Paperless) */
export const K = {
  beleg: {
    id: 'kosten.beleg', text: 'Kostenbeleg (Rechnung, Bescheid, Abschlag)',
    beschreibung: 'Belege, die in „Laufende Kosten“ zu einer Kostenposition hochgeladen werden. Die Verknüpfung speichert das Portal zusätzlich selbst.',
    platzhalter: [
      { name: 'kostenart', text: 'Kostenart', beispiel: 'Heizstrom' },
      { name: 'lieferant', text: 'Lieferant/Behörde (Korrespondent)', beispiel: 'Stadtwerke' },
      { name: 'datum', text: 'Belegdatum', beispiel: '2026-11-08' },
      { name: 'betrag', text: 'Betrag', beispiel: 123.45 },
      { name: 'zeitraum', text: 'Leistungszeitraum', beispiel: '01.01.2026–31.12.2026' },
      { name: 'objekt', text: 'Haus', beispiel: 'Mein Haus' },
      PH.datei, PH.heute, PH.benutzer, PH_DOKID,
    ],
    standard: { titel: '{kostenart} {zeitraum} – {lieferant}', korrespondent: '{lieferant}', datum: '{datum}', tags: 'Nebenkosten, {objekt}' },
  },
  abrechnung: {
    id: 'abrechnung', text: 'Nebenkostenabrechnung an den Mieter',
    beschreibung: 'PDF der festgeschriebenen Abrechnung (Nebenkostenabrechnung → Paperless).',
    platzhalter: [
      { name: 'jahr', text: 'Abrechnungsjahr', beispiel: '2026' },
      { name: 'mieter', text: 'Mieter (Korrespondent)', beispiel: 'Erika Muster' },
      { name: 'einheit', text: 'Wohnung', beispiel: 'OG' },
      { name: 'ergebnis', text: 'Nachzahlung (+) / Guthaben (−)', beispiel: 84.5 },
      { name: 'objekt', text: 'Haus', beispiel: 'Mein Haus' },
      PH.heute, PH.benutzer, PH_DOKID,
    ],
    standard: { titel: 'Nebenkostenabrechnung {jahr} – {mieter} ({einheit})', korrespondent: '{mieter}', datum: '{heute}', tags: 'Nebenkostenabrechnung, {objekt}' },
  },
} satisfies Record<string, KontextDef>;

export const MIETE_KONTEXTE: KontextDef[] = Object.values(K);

/** Paperless der Vermietung oder verständlicher Fehler */
export async function paperless(): Promise<Paperless> {
  const pl = await paperlessFuer('miete');
  if (!pl) throw new BusinessError('Paperless ist für die Vermietung nicht eingerichtet (Administration → Schnittstellen → Paperless → Vermietung).');
  return pl;
}

/** Kurzform eines Paperless-Dokuments für Auswahllisten */
export async function dokumentKurz(pl: Paperless, d: Record<string, any>) {
  return {
    id: Number(d.id), titel: String(d.title ?? ''), datum: String(d.created_date ?? d.created ?? '').slice(0, 10),
    korrespondent: await pl.korrespondentName(d.correspondent), dateiname: String(d.original_file_name ?? ''),
  };
}
