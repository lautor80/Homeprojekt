/**
 * Hallenschlüssel (#215): Vorgang und Protokoll anlegen – ohne Abhängigkeit zur Hallenabrechnung, damit auch
 * halle/daten.ts (manuelle Position 008/009) Vorgänge schreiben kann.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../verein.js';
import { vorgangsNummer, type Art } from './regeln.js';

export interface Ich { id: string | null; name: string }

export interface VorgangNeu {
  art: Art; adrnr: string; person: string; datum: string; schluessel_nr?: string | null; pfand?: number | null; zustand?: string | null;
  tco?: Ich | null; status?: 'WARTET' | 'QUITTIERT'; quittiert_von?: string | null; quittiert_art?: 'KUNDE' | 'TCO' | 'ALTFALL' | null;
  mitToken?: boolean; linkTage?: number; rgnr?: string | null; rgpos?: number | null; internenr?: string | null; doc_id?: number | null;
  quelle?: 'APP' | 'RECHNUNG' | 'IMPORT' | 'BESTAND'; bemerkung?: string | null; angelegt_von: string;
}

export async function protokoll(tx: Db, vorgangId: number, ich: Ich, aktion: string, text: string | null) {
  await tx`insert into tco.schluessel_verlauf (vorgang_id, von, benutzer_id, aktion, text) values (${vorgangId}, ${ich.name}, ${ich.id}, ${aktion}, ${text})`;
}

export async function vorgangAnlegen(tx: Db, v: VorgangNeu): Promise<{ id: number; nummer: string; token: string | null }> {
  const quittiert = v.status === 'QUITTIERT';
  const token = v.mitToken ? randomBytes(24).toString('hex') : null;
  const [r] = await tx`
    insert into tco.schluessel_vorgang (nummer, art, adrnr, person, datum, schluessel_nr, pfand, zustand, tco_benutzer_id, tco_name, status,
                                        quittiert_am, quittiert_von, quittiert_art, token, token_bis, rgnr, rgpos, internenr, doc_id, quelle, bemerkung, angelegt_von)
    values ('neu-' || gen_random_uuid()::text, ${v.art}, ${v.adrnr}, ${v.person}, ${v.datum}, ${v.schluessel_nr?.trim() || null}, ${v.pfand ?? null}, ${v.zustand ?? null},
            ${v.tco?.id ?? null}, ${v.tco?.name ?? ''}, ${v.status ?? 'WARTET'},
            ${quittiert ? tx`now()` : null}, ${quittiert ? v.quittiert_von ?? null : null}, ${quittiert ? v.quittiert_art ?? 'TCO' : null},
            ${token}, ${token ? tx`now() + make_interval(days => ${v.linkTage ?? 30})` : null},
            ${v.rgnr ?? null}, ${v.rgpos ?? null}, ${v.internenr ?? null}, ${v.doc_id ?? null}, ${v.quelle ?? 'APP'}, ${v.bemerkung?.trim() || null}, ${v.angelegt_von})
    returning id`;
  const nummer = vorgangsNummer(Number(v.datum.slice(0, 4)), r.id);
  await tx`update tco.schluessel_vorgang set nummer = ${nummer} where id = ${r.id}`;
  return { id: r.id, nummer, token };
}
