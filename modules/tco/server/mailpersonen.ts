/**
 * E-Mail-Protokoll (Administration → E-Mail-Protokoll): Personen des Vereinsmoduls zu Empfängeradressen –
 * Mitglieder (eigene Adresse und die des abweichenden Zahlers), Hallenkunden (EP3) und Registrierungen.
 */
import type { Tx } from '../../../server/src/db.js';
import type { MailPerson } from '../../../server/src/lib/mailuebersicht.js';

export async function mailPersonen(db: Tx, emails: string[]): Promise<MailPerson[]> {
  if (!emails.length) return [];
  const rows = await db`
    select lower(btrim(email)) as email, btrim(concat_ws(' ', vorname, nachname)) as name, 'Mitglied' as art
      from tco.mitglieder where lower(btrim(email)) = any(${emails}::text[])
    union
    select lower(btrim(emailkih)), btrim(concat_ws(' ', vorname, nachname)), 'Mitglied, Adresse des Zahlers'
      from tco.mitglieder where lower(btrim(emailkih)) = any(${emails}::text[])
    union
    select lower(btrim(email)), btrim(concat_ws(' ', vorname, nachname)), 'Hallenkunde'
      from tco.kunden where lower(btrim(email)) = any(${emails}::text[])
    union
    select lower(btrim(email)), coalesce(nullif(btrim(concat_ws(' ', vorname, nachname)), ''), anzeigename), 'Registrierung'
      from tco.registrierungen where lower(btrim(email)) = any(${emails}::text[])
    order by 1, 3, 2`;
  return rows.map((r) => ({ email: r.email as string, name: (r.name as string | null) ?? '', art: r.art as string }));
}
