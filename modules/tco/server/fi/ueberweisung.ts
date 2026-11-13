/**
 * FI-Belege: Paperless-Belege, die dem Einreicher zu erstatten sind – Custom Field „Folgeaktion“ = „Überweisung an
 * Einreicher“ und Feld „SAP“ leer (noch keiner Buchung zugeordnet). Je Beleg Vorschau und QR-Code für die Überweisung
 * (upload/zahlung.ts): Empfänger und IBAN kommen über den Einreicher (Dokumenten-Upload des Portals, tco.upload_folge)
 * aus dem Mitgliederstamm, der Betrag aus dem Betragsfeld des Belegs.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { paperless } from '../verein.js';
import { FOLGEAKTION_FELD, istUeberweisungEinreicher } from '../upload/logik.js';
import { zahlungBauen, type ZahlungDaten } from '../upload/zahlung.js';
import { belegAus, type OffenerBeleg } from './belege.js';

import { folgeText, sapLeer } from './ueberweisung-regeln.js';

export { folgeText, sapLeer };

export interface UeberweisungBeleg extends OffenerBeleg { einreicher: string | null; hochgeladen: string | null; erledigt: boolean }

async function felder(v: Verein) {
  const pl = paperless(v);
  const folge = await pl.feldDetails(FOLGEAKTION_FELD);
  if (!folge) throw new BusinessError(`Das Custom Field „${FOLGEAKTION_FELD}“ gibt es in Paperless noch nicht – es entsteht mit dem ersten Dokumenten-Upload mit Folgeaktion.`);
  const sap = await pl.feld(v.fi_feld_sap);
  if (!sap) throw new BusinessError(`Custom Field „${v.fi_feld_sap}“ fehlt in Paperless.`);
  return { pl, folge, sap, optionen: folge.extra_data?.select_options ?? [] };
}

const passt = async (v: Verein, f: Awaited<ReturnType<typeof felder>>, d: Record<string, any>) =>
  istUeberweisungEinreicher(folgeText(await f.pl.feldWert(d, String(f.folge.id)), f.optionen)) && sapLeer(await f.pl.feldWert(d, v.fi_feld_sap));

/** Belege mit Folgeaktion „Überweisung an Einreicher“ und leerem Feld „SAP“, neueste zuerst */
export async function ueberweisungsBelege(v: Verein, db: Db): Promise<UeberweisungBeleg[]> {
  const f = await felder(v);
  // in Paperless vorfiltern (Folgeaktion gesetzt), die genaue Prüfung – Text der Folgeaktion, SAP leer – folgt hier
  const docs = await f.pl.dokumenteSuchen({ custom_field_query: JSON.stringify([f.folge.id, 'exists', true]), ordering: '-created' });
  const treffer: Record<string, any>[] = [];
  for (const d of docs) if (await passt(v, f, d)) treffer.push(d);
  const ids = treffer.map((d) => Number(d.id));
  const up = ids.length ? await db`select dok_id, einreicher, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, erledigt_am from tco.upload_folge where dok_id = any(${ids}) order by id` : [];
  const out: UeberweisungBeleg[] = [];
  for (const d of treffer) {
    const u = up.filter((x) => Number(x.dok_id) === Number(d.id)).at(-1);
    out.push({ ...(await belegAus(v, d)), einreicher: (u?.einreicher as string | undefined) ?? null, hochgeladen: (u?.am as string | undefined) ?? null, erledigt: !!u?.erledigt_am });
  }
  return out;
}

/** Zahlungsdaten und QR-Code zu einem dieser Belege; ohne Angabe gilt der Betrag aus dem Betragsfeld des Belegs */
export async function ueberweisungZahlung(v: Verein, db: Db, id: number, betrag: number | null, zweck: string | null): Promise<ZahlungDaten> {
  const d = await ueberweisungDokument(v, id);
  const b = await belegAus(v, d);
  const [u] = await db`select einreicher, benutzer_id, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am from tco.upload_folge where dok_id = ${id} order by id desc limit 1`;
  const wert = betrag ?? (b.betrag != null && Math.abs(b.betrag) >= 0.01 ? Math.round(Math.abs(b.betrag) * 100) / 100 : null);
  return zahlungBauen(db, {
    id, titel: b.titel || `Beleg ${id}`, einreicher: (u?.einreicher as string | undefined) ?? '', benutzer_id: (u?.benutzer_id as string | undefined) ?? null,
    dok_id: id, am: (u?.am as string | undefined) ?? b.datum ?? '',
  }, wert, zweck);
}

/** Dokument lesen und prüfen, dass es zu dieser Liste gehört (Folgeaktion „Überweisung an Einreicher“) – Schutz für Vorschau und QR-Code */
export async function ueberweisungDokument(v: Verein, id: number): Promise<Record<string, any>> {
  const f = await felder(v);
  let d: Record<string, any>;
  try { d = await f.pl.dokument(id); } catch (e) {
    throw new BusinessError((e as { status?: number }).status === 404 ? `Dokument ${id} wurde in Paperless nicht gefunden.` : (e as Error).message, 404);
  }
  if (!istUeberweisungEinreicher(folgeText(await f.pl.feldWert(d, String(f.folge.id)), f.optionen))) throw new BusinessError(`Dokument ${id} hat nicht die Folgeaktion „Überweisung an Einreicher“.`, 403);
  return d;
}
