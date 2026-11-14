/**
 * Rollenabgleich der Vereinsbenutzer (Benutzerverwaltung → „Rollen prüfen“ und regelmäßiger Lauf):
 *
 *   Mitglied (Eintritt gesetzt, Austritt leer oder noch nicht erreicht)  →  Rollen „Mitglied“ und „Hallennutzer“
 *   Nichtmitglied (EP3-Kunde, Hallennutzer, ausgetretenes Mitglied)      →  nur „Hallennutzer“, „Mitglied“ wird entzogen
 *
 * Betroffen sind aktive Benutzer, die einem Mitglied (tco.mitgliedera) oder einem Hallenkunden (tco.kunden) zugeordnet
 * sind. Weitere Rollen (Vorstand, Trainer, Administrator …) vergibt ein Administrator – der Abgleich lässt sie stehen.
 * Benutzer ohne Zuordnung (z. B. Euroflex) bleiben unberührt. Gesperrte Benutzer auch (Sperre nach Austritt).
 */
import type { Db } from '../verein.js';
import { rolleSicherstellen, ROLLE, ROLLE_MITGLIED } from '../platz/registrierung.js';

export interface RollenAenderung { username: string; name: string; mitglied: boolean; ergaenzt: string[]; entzogen: string[] }

const ROLLENNAME: Record<string, string> = { [ROLLE_MITGLIED]: 'Mitglied', [ROLLE]: 'Hallennutzer' };

/** Abgleich berechnen und – mit ausfuehren – durchführen. Liefert je Benutzer, was sich ändert (bzw. geändert hat). */
export async function rollenAbgleich(tx: Db, o: { ausfuehren: boolean }): Promise<RollenAenderung[]> {
  if (o.ausfuehren) await rolleSicherstellen(tx);
  const rows = await tx`
    with zuordnung as (
      select a.benutzer_id as id,
             bool_or(m.eintritt is not null and (m.austritt is null or m.austritt >= current_date)) as mitglied
        from tco.mitgliedera a join tco.mitglieder m on m.adrnr = a.adrnr
       where a.benutzer_id is not null group by a.benutzer_id
      union all
      select k.benutzer_id, false from tco.kunden k where k.benutzer_id is not null
    )
    select u.id, u.username, coalesce(u.display_name, u.username) as name, bool_or(z.mitglied) as mitglied,
           coalesce(array_agg(distinct ur.role_id) filter (where ur.role_id is not null), '{}') as rollen
      from zuordnung z join core.users u on u.id = z.id
      left join core.user_roles ur on ur.user_id = u.id
     where u.active
     group by u.id, u.username, u.display_name
     order by lower(u.username)`;
  const out: RollenAenderung[] = [];
  for (const u of rows) {
    const rollen = new Set(u.rollen as string[]);
    const soll = u.mitglied ? [ROLLE_MITGLIED, ROLLE] : [ROLLE];
    const ergaenzt = soll.filter((r) => !rollen.has(r));
    const entzogen = !u.mitglied && rollen.has(ROLLE_MITGLIED) ? [ROLLE_MITGLIED] : [];
    if (!ergaenzt.length && !entzogen.length) continue;
    if (o.ausfuehren) {
      for (const r of ergaenzt) await tx`insert into core.user_roles (user_id, role_id) values (${u.id}, ${r}) on conflict do nothing`;
      for (const r of entzogen) await tx`delete from core.user_roles where user_id = ${u.id} and role_id = ${r}`;
      if (entzogen.length) await tx`delete from core.sessions where user_id = ${u.id}`; // Rechte gelten sofort
    }
    out.push({ username: u.username, name: u.name, mitglied: !!u.mitglied, ergaenzt: ergaenzt.map((r) => ROLLENNAME[r]), entzogen: entzogen.map((r) => ROLLENNAME[r]) });
  }
  return out;
}

export function rollenText(l: RollenAenderung[], ausgefuehrt: boolean): string {
  if (!l.length) return 'Alle Rollen stimmen: Mitglieder haben „Mitglied“ und „Hallennutzer“, Nichtmitglieder „Hallennutzer“.';
  const erg = l.filter((x) => x.ergaenzt.length).length;
  const ent = l.filter((x) => x.entzogen.length).length;
  const teile = [erg && `${erg} ${erg === 1 ? 'Benutzer erhält' : 'Benutzer erhalten'} fehlende Rollen`, ent && `${ent} ${ent === 1 ? 'Nichtmitglied verliert' : 'Nichtmitglieder verlieren'} die Rolle „Mitglied“`].filter(Boolean);
  return `${teile.join(', ')}${ausgefuehrt ? ' – angepasst.' : '.'}`;
}
