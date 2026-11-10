/**
 * Rückmeldungen zu gesendeten E-Mails verbuchen (POST /api/mail/eingang, aufgerufen vom n8n-Workflow „TCO Maileingang“).
 * Zugeordnet wird zuerst über die Message-ID (Antwort: In-Reply-To/References; Rückläufer: Message-ID im Text), sonst
 * - Rückläufer: jüngste gesendete E-Mail der letzten 7 Tage an eine im Text genannte Adresse,
 * - Abwesenheit: jüngste gesendete E-Mail der letzten 2 Tage an den Absender,
 * - Antwort: jüngste gesendete E-Mail der letzten 30 Tage an den Absender mit demselben Betreff.
 * Was sich nicht zuordnen lässt, wird nicht gespeichert (n8n liest ganze Posteingänge).
 */
import type { Tx } from '../db.js';
import { adressen } from './mailuebersicht.js';
import { adressenImText, betreffKern, einordnen, eingangZeit, messageIds, messageIdsImText, rueckGrund, type Eingang, type EingangArt } from './maileingang.js';

const TAG = 86_400_000;
export interface EingangErgebnis { zugeordnet: boolean; art: EingangArt; protokoll: number | null; neu: boolean }

export async function eingangVerbuchen(db: Tx, e: Eingang): Promise<EingangErgebnis> {
  const art = einordnen(e);
  const zeit = eingangZeit(e.datum);
  const bis = new Date(zeit.getTime() + 600_000); // Uhren von Mailserver und Portal dürfen etwas abweichen
  const kandidaten = (tage: number) => db`
    select id, an, betreff from core.mail_protokoll
     where status = 'gesendet' and zeit between ${new Date(zeit.getTime() - tage * TAG)} and ${bis}
     order by id desc limit 1000`;
  let protokoll: number | null = null;

  const bezug = messageIds(e.in_reply_to, e.references, ...(art === 'unzustellbar' ? messageIdsImText(e.text) : []));
  if (bezug.length) {
    const [p] = await db`select id from core.mail_protokoll where message_id = any(${bezug}) order by id desc limit 1`;
    if (p) protokoll = Number(p.id);
  }
  if (protokoll === null && art === 'unzustellbar') {
    const fehlgeschlagen = new Set(adressenImText(e.text, [e.postfach, e.von]));
    if (fehlgeschlagen.size) {
      const p = (await kandidaten(7)).find((r) => adressen(r.an as string | null).some((a) => fehlgeschlagen.has(a)));
      if (p) protokoll = Number(p.id);
    }
  }
  if (protokoll === null && art !== 'unzustellbar') {
    const von = adressen(e.von)[0];
    const kern = betreffKern(e.betreff);
    if (von) {
      const p = (await kandidaten(art === 'abwesenheit' ? 2 : 30)).find((r) => {
        if (!adressen(r.an as string | null).includes(von)) return false;
        if (art === 'abwesenheit') return true;
        const gesendet = betreffKern(r.betreff as string | null);
        return gesendet.length >= 4 && kern.includes(gesendet);
      });
      if (p) protokoll = Number(p.id);
    }
  }
  if (protokoll === null) return { zugeordnet: false, art, protokoll: null, neu: false };

  const mid = messageIds(e.message_id)[0] ?? null;
  const r = await db`
    insert into core.mail_antworten (protokoll_id, art, zeit, von, betreff, grund, postfach, message_id)
    values (${protokoll}, ${art}, ${zeit}, ${(e.von ?? '').slice(0, 300) || null}, ${(e.betreff ?? '').slice(0, 300) || null},
            ${art === 'unzustellbar' ? rueckGrund(e.text) || null : null}, ${(e.postfach ?? '').slice(0, 300) || null}, ${mid})
    on conflict do nothing returning id`;
  return { zugeordnet: true, art, protokoll, neu: r.length > 0 };
}
