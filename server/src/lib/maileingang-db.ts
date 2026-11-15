/**
 * Rückmeldungen zu gesendeten E-Mails verbuchen (POST /api/mail/eingang, aufgerufen vom n8n-Workflow „TCO Maileingang“).
 * Zugeordnet wird zuerst über die Message-ID (Antwort: In-Reply-To/References; Rückläufer: Message-ID im Text), sonst
 * - Rückläufer: jüngste gesendete E-Mail der letzten 7 Tage an eine im Text genannte Adresse,
 * - Abwesenheit: jüngste gesendete E-Mail der letzten 2 Tage an den Absender,
 * - Antwort: jüngste gesendete E-Mail der letzten 30 Tage an den Absender mit demselben Betreff.
 * Was sich nicht zuordnen lässt, wird nicht gespeichert (n8n liest ganze Posteingänge).
 *
 * Rückläufer mit dauerhaftem Empfängerfehler („Adresse gibt es nicht“) werden zusätzlich den Fachmodulen gemeldet, die die Adresse
 * bei ihrer Person als unzustellbar vermerken (lib/mailsperre.ts) – an sie wird dann nicht mehr gesendet.
 */
import type { Tx } from '../db.js';
import { hinweisMelden } from './hinweise.js';
import { adressen } from './mailuebersicht.js';
import { unzustellbarMelden } from './mailsperre.js';
import { dauerhafterEmpfaengerfehler, dsnAbschnitt, dsnEmpfaenger } from './mailzustellung.js';
import { adressenImText, betreffKern, einordnen, eingangZeit, messageIds, messageIdsImText, rueckGrund, type Eingang, type EingangArt } from './maileingang.js';

const TAG = 86_400_000;
export interface EingangErgebnis {
  zugeordnet: boolean; art: EingangArt; protokoll: number | null; neu: boolean;
  /** Rückläufer: Adressen, die jetzt bei einer Person als unzustellbar vermerkt sind */
  vermerkt?: string[];
}

/**
 * Rückläufer: dauerhaft abgelehnte Adressen bei den Personen vermerken.
 * Sicher genannt sind die Empfänger eines Zustellberichts (Final-Recipient, Action: failed) – sie zählen auch ohne zugeordnete
 * E-Mail des Portals. Ohne Zustellbericht zählen nur Adressen aus dem Text, an die die zugeordnete E-Mail tatsächlich ging.
 */
async function unzustellbarVermerken(db: Tx, e: Eingang, protokoll: number | null): Promise<string[]> {
  const dsn = dsnEmpfaenger(e.text);
  let kandidaten = dsn;
  if (!dsn.length && protokoll !== null) {
    const [p] = await db`select an from core.mail_protokoll where id = ${protokoll}`;
    const empfaenger = new Set(adressen(p?.an as string | null));
    kandidaten = adressenImText(e.text, [e.postfach, e.von]).filter((a) => empfaenger.has(a));
  }
  const vermerkt: string[] = [];
  for (const a of kandidaten) {
    // je Empfänger dessen Abschnitt des Zustellberichts, sonst die Fehlerzeilen des Mailservers
    const grund = dsn.length ? rueckGrund(dsnAbschnitt(e.text, a)) || rueckGrund(e.text) : rueckGrund(e.text);
    if (!dauerhafterEmpfaengerfehler(grund)) continue;
    vermerkt.push(...await unzustellbarMelden([a], grund, 'ruecklaeufer'));
  }
  return [...new Set(vermerkt)];
}

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
  // erst prüfen, dann vermerken: Ein Fehler beim Vermerken darf die Verbuchung nicht verhindern
  const vermerkt = art === 'unzustellbar' ? await unzustellbarVermerken(db, e, protokoll).catch(() => [] as string[]) : [];
  if (protokoll === null) return { zugeordnet: false, art, protokoll: null, neu: false, ...(vermerkt.length ? { vermerkt } : {}) };

  const mid = messageIds(e.message_id)[0] ?? null;
  const r = await db`
    insert into core.mail_antworten (protokoll_id, art, zeit, von, betreff, grund, postfach, message_id)
    values (${protokoll}, ${art}, ${zeit}, ${(e.von ?? '').slice(0, 300) || null}, ${(e.betreff ?? '').slice(0, 300) || null},
            ${art === 'unzustellbar' ? rueckGrund(e.text) || null : null}, ${(e.postfach ?? '').slice(0, 300) || null}, ${mid})
    on conflict do nothing returning id`;
  // Arbeitsvorrat (#232, V1): Rückläufer und Antworten stehen unter „Administration“, bis jemand „gesehen“ bestätigt – je Art ein Hinweis
  if (r.length > 0) {
    await hinweisMelden(db, {
      modul: 'core', quelle: 'MAIL_RUECKLAUF', objekt: art, bereich: 'Administration', recht: 'core.mail:display', icon: 'email', pfad: '/admin/mailprotokoll',
      art: art === 'unzustellbar' ? 'E-Mail unzustellbar' : art === 'abwesenheit' ? 'Abwesenheitsnotiz erhalten' : 'Antwort auf eine E-Mail erhalten',
      state: art === 'unzustellbar' ? 'Negative' : 'Information',
      titel: `von ${(e.von ?? '').slice(0, 120) || 'unbekannt'}`, text: (e.betreff ?? '').replace(/\s+/g, ' ').slice(0, 300),
    });
  }
  return { zugeordnet: true, art, protokoll, neu: r.length > 0, ...(vermerkt.length ? { vermerkt } : {}) };
}
