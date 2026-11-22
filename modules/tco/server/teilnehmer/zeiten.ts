import { BusinessError } from '../../../../server/src/errors.js';
import { heute } from '../format.js';
import type { Db } from '../verein.js';

/**
 * Trainingszeiten der Teilnehmer Jugendtraining je Saison.
 *
 * Eine Saison ist „Sommer“ oder „Winter“ eines Jahres. Der Winter zählt zum Jahr, in dem er beginnt:
 * WINTER 2026 = Winter 2026/27. Je Teilnehmer und Saison beliebig viele feste Termine (Wochentag Mo–So, von–bis).
 * Ohne Angabe gilt die Saison zum heutigen Tag: April–September Sommer, Oktober–März Winter.
 */

export const SAISONS = ['SOMMER', 'WINTER'] as const;
export type Saison = (typeof SAISONS)[number];
export interface SaisonRef { jahr: number; saison: Saison }
export interface Trainingszeit { wochentag: number; von: string; bis: string; bemerkung: string }

/** 1 = Montag … 7 = Sonntag */
export const WOCHENTAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;
export const WOCHENTAGE_LANG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'] as const;

/** Saison zu einem Datum (ISO): April–September Sommer, Oktober–Dezember Winter des Jahres, Januar–März Winter des Vorjahres */
export function saisonAm(datum = heute()): SaisonRef {
  const jahr = Number(datum.slice(0, 4));
  const monat = Number(datum.slice(5, 7));
  if (monat >= 4 && monat <= 9) return { jahr, saison: 'SOMMER' };
  return monat >= 10 ? { jahr, saison: 'WINTER' } : { jahr: jahr - 1, saison: 'WINTER' };
}

/** „Sommer 2027“ bzw. „Winter 2026/27“ */
export function saisonText({ jahr, saison }: SaisonRef): string {
  return saison === 'SOMMER' ? `Sommer ${jahr}` : `Winter ${jahr}/${String((jahr + 1) % 100).padStart(2, '0')}`;
}

/** Dieselbe Saisonart im Vorjahr – Vorschlag zum Übernehmen (Sommer 2027 ← Sommer 2026) */
export function vorjahresSaison({ jahr, saison }: SaisonRef): SaisonRef {
  return { jahr: jahr - 1, saison };
}

const uhr = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
};

/**
 * Eingabe prüfen und vereinheitlichen: Uhrzeit HH:MM, Ende nach Beginn, keine Überschneidung am selben Tag.
 * Sortiert nach Wochentag und Beginn.
 */
export function zeitenPruefen(liste: Trainingszeit[]): Trainingszeit[] {
  const out = liste.map((z, i) => {
    const tag = Number(z.wochentag);
    if (!Number.isInteger(tag) || tag < 1 || tag > 7) throw new BusinessError(`Zeile ${i + 1}: Bitte einen Wochentag (Mo–So) wählen.`);
    const von = uhr(String(z.von ?? ''));
    const bis = uhr(String(z.bis ?? ''));
    if (!von || !bis) throw new BusinessError(`Zeile ${i + 1} (${WOCHENTAGE[tag - 1]}): Uhrzeit bitte im Format HH:MM angeben.`);
    if (bis <= von) throw new BusinessError(`Zeile ${i + 1} (${WOCHENTAGE[tag - 1]}): Das Ende muss nach dem Beginn liegen.`);
    return { wochentag: tag, von, bis, bemerkung: String(z.bemerkung ?? '').trim().slice(0, 200) };
  }).sort((a, b) => a.wochentag - b.wochentag || a.von.localeCompare(b.von));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    if (a.wochentag === b.wochentag && b.von < a.bis) {
      throw new BusinessError(`${WOCHENTAGE_LANG[a.wochentag - 1]}: ${a.von}–${a.bis} und ${b.von}–${b.bis} überschneiden sich.`);
    }
  }
  return out;
}

/** Kurztext für Listen: „Mo 16:00–17:00, Mi 17:00–18:30“ */
export function zeitenText(liste: Trainingszeit[]): string {
  return liste.map((z) => `${WOCHENTAGE[z.wochentag - 1]} ${z.von}–${z.bis}`).join(', ');
}

/** Alle Trainingszeiten einer Saison (optional nur für eine Person), je Adressnummer sortiert */
export async function zeitenLesen(db: Db, s: SaisonRef, adrnr?: string): Promise<Map<string, Trainingszeit[]>> {
  const rows = await db`
    select adrnr, wochentag, to_char(von, 'HH24:MI') as von, to_char(bis, 'HH24:MI') as bis, bemerkung
      from tco.tn_trainingszeit
     where jahr = ${s.jahr} and saison = ${s.saison} ${adrnr ? db`and adrnr = ${adrnr}` : db``}
     order by adrnr, wochentag, von`;
  const m = new Map<string, Trainingszeit[]>();
  for (const r of rows) {
    const l = m.get(r.adrnr) ?? [];
    l.push({ wochentag: Number(r.wochentag), von: r.von, bis: r.bis, bemerkung: r.bemerkung ?? '' });
    m.set(r.adrnr, l);
  }
  return m;
}

/** Trainingszeiten einer Person für eine Saison vollständig ersetzen (leere Liste = alle entfernen) */
export async function zeitenSetzen(tx: Db, adrnr: string, s: SaisonRef, liste: Trainingszeit[]): Promise<Trainingszeit[]> {
  const neu = zeitenPruefen(liste);
  const [p] = await tx`select 1 from tco.mitglieder where adrnr = ${adrnr}`;
  if (!p) throw new BusinessError('Person nicht gefunden.');
  await tx`delete from tco.tn_trainingszeit where adrnr = ${adrnr} and jahr = ${s.jahr} and saison = ${s.saison}`;
  for (const z of neu) {
    await tx`insert into tco.tn_trainingszeit (adrnr, jahr, saison, wochentag, von, bis, bemerkung)
             values (${adrnr}, ${s.jahr}, ${s.saison}, ${z.wochentag}, ${z.von}::time, ${z.bis}::time, ${z.bemerkung})`;
  }
  return neu;
}

/**
 * Zeiten aus einer Saison in eine andere übernehmen – nur für die angegebenen Personen (laufende Teilnehmer)
 * und nur, wenn sie in der Zielsaison noch keine Zeiten haben. Bereits gepflegte Zielsaisons bleiben unverändert.
 */
export async function zeitenUebernehmen(tx: Db, von: SaisonRef, nach: SaisonRef, adrnrs: string[]) {
  if (von.jahr === nach.jahr && von.saison === nach.saison) throw new BusinessError('Quell- und Zielsaison sind gleich.');
  if (!adrnrs.length) return { personen: 0, zeiten: 0, uebersprungen: 0 };
  const belegt = new Set((await tx`select distinct adrnr from tco.tn_trainingszeit
                                    where jahr = ${nach.jahr} and saison = ${nach.saison} and adrnr = any(${adrnrs})`).map((r) => r.adrnr as string));
  const quelle = (await tx`select distinct adrnr from tco.tn_trainingszeit
                            where jahr = ${von.jahr} and saison = ${von.saison} and adrnr = any(${adrnrs})`).map((r) => r.adrnr as string);
  const ziel = quelle.filter((a) => !belegt.has(a));
  if (!ziel.length) return { personen: 0, zeiten: 0, uebersprungen: quelle.length };
  const r = await tx`
    insert into tco.tn_trainingszeit (adrnr, jahr, saison, wochentag, von, bis, bemerkung)
    select adrnr, ${nach.jahr}, ${nach.saison}, wochentag, von, bis, bemerkung
      from tco.tn_trainingszeit
     where jahr = ${von.jahr} and saison = ${von.saison} and adrnr = any(${ziel})`;
  return { personen: ziel.length, zeiten: r.count, uebersprungen: quelle.length - ziel.length };
}
