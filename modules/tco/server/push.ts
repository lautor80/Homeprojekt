/**
 * Push-Nachrichten des Vereins aufs Handy (Technik: server/src/lib/push.ts). Jede Art lässt sich vom Benutzer unter
 * „Benachrichtigungen“ im Benutzermenü ein- und ausschalten.
 *
 *  - Mitglieder: Einladung zu einer Veranstaltung, abgesagte Veranstaltung – an die Betroffenen und ihre Familie
 *    (mitglieder/familie.ts), damit Eltern von den Terminen ihrer Kinder erfahren.
 *  - Vorstand, Kassenwart, Administration: neue Mitgliedsanträge und Kündigungen sowie die Hinweise im Arbeitsvorrat
 *    (hinweise.ts) – Art „tco:<Quelle des Hinweises>“.
 */
import { pushAnBenutzer, pushStill, type PushArt, type PushNachricht } from '../../../server/src/lib/push.js';
import type { Db } from './verein.js';

export const PUSH = {
  einladung: 'tco:KAL_EINLADUNG', absage: 'tco:KAL_ABSAGE', antrag: 'tco:MITGLIEDSANTRAG', kuendigung: 'tco:KUENDIGUNG', aenderung: 'tco:MG_AENDERUNG',
} as const;

const KAL = 'tco.kalender:anmelden', MG = 'tco.mitglieder:display', HALLE = 'tco.platz:admin';
export const TCO_PUSH_ARTEN: PushArt[] = [
  { id: PUSH.einladung, gruppe: 'Vereinskalender', text: 'Einladung zu einer Veranstaltung', recht: KAL },
  { id: PUSH.absage, gruppe: 'Vereinskalender', text: 'Veranstaltung abgesagt', recht: KAL },
  { id: PUSH.antrag, gruppe: 'Mitglieder', text: 'Neuer Mitgliedsantrag oder Vertragswechsel', recht: 'tco.antraege:display' },
  { id: PUSH.kuendigung, gruppe: 'Mitglieder', text: 'Kündigung eingereicht', recht: 'tco.mitglieder:edit' },
  { id: PUSH.aenderung, gruppe: 'Mitglieder', text: 'Beitragswechsel oder Jugendtraining eingereicht (Freigabe)', recht: 'tco.mitglieder:edit' },
  { id: 'tco:MG_KUENDIGUNG', gruppe: 'Mitglieder', text: 'Kündigung freigegeben', recht: MG, hinweis: true },
  { id: 'tco:MG_VORGANG', gruppe: 'Mitglieder', text: 'Beitragswechsel oder Jugendtraining durch das Mitglied', recht: MG, hinweis: true },
  { id: 'tco:MG_BANK', gruppe: 'Mitglieder', text: 'Bankverbindung geändert', recht: MG, hinweis: true },
  { id: 'tco:MG_KONTAKT', gruppe: 'Mitglieder', text: 'Kontaktdaten geändert', recht: MG, hinweis: true },
  { id: 'tco:MG_GRUPPE', gruppe: 'Mitglieder', text: 'Mitglied trägt sich in eine Gruppe ein oder aus', recht: MG, hinweis: true },
  { id: 'tco:MG_ZUGANG', gruppe: 'Mitglieder', text: 'Mitglied hat seinen Zugang eingerichtet', recht: MG, hinweis: true },
  { id: 'tco:HN_NEU', gruppe: 'Halle', text: 'Neuer Hallennutzer', recht: HALLE, hinweis: true },
  { id: 'tco:HN_KONTAKT', gruppe: 'Halle', text: 'Hallennutzer: Kontaktdaten geändert', recht: HALLE, hinweis: true },
  { id: 'tco:MG_SPERRE', gruppe: 'Administration', text: 'Benutzer nach Austritt gesperrt', recht: 'core.users:display', hinweis: true },
  { id: 'tco:SCHNITTSTELLE', gruppe: 'Administration', text: 'Schnittstelle gestört', recht: 'core.settings:edit', hinweis: true },
];

/** Benutzer der genannten Personen und ihrer Familien (gleicher Zahler oder Familienverknüpfung, auch über mehrere Schritte) */
export async function familienBenutzer(db: Db, adrnrs: string[]): Promise<string[]> {
  if (!adrnrs.length) return [];
  const rows = await db`
    with recursive kanten as (
      select adrnr as a, adrnrkih as b from tco.mitglieder
       where adrnrkih is not null and ltrim(trim(adrnrkih), '0') <> '' and adrnrkih <> adrnr
      union
      select adrnr_a, adrnr_b from tco.familienverknuepfungen
    ), beide as (
      select a, b from kanten union select b, a from kanten
    ), fam(adrnr) as (
      select unnest(${adrnrs}::text[])
      union
      select k.b from fam f join beide k on k.a = f.adrnr
    )
    select distinct a.benutzer_id
      from fam f join tco.mitglied_benutzer a on a.adrnr = f.adrnr
      join tco.mitglieder m on m.adrnr = f.adrnr
     where (m.austritt is null or m.austritt >= current_date)`;
  return rows.map((r) => r.benutzer_id as string);
}

/** Push an Mitglieder und ihre Familien – wartet nicht und scheitert still */
export function pushAnMitglieder(db: Db, adrnrs: string[], art: string, n: PushNachricht): void {
  pushStill(async () => pushAnBenutzer(await familienBenutzer(db, adrnrs), art, n));
}
