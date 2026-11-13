/**
 * FI-Belege: Paperless-Belege, die dem Einreicher zu erstatten sind – Custom Field „Folgeaktion“ = „Überweisung an
 * Einreicher“, Feld „SAP“ leer (noch keiner Buchung zugeordnet) und Feld „Status“ = „Offen“. Die Bestätigung der
 * Überweisung setzt den Status auf „gezahlt“. Je Beleg Vorschau und QR-Code für die Überweisung
 * (upload/zahlung.ts): Der Einreicher steht im Paperless-Feld „Eingereicht durch“ (sonst: Benutzer des Dokumenten-Uploads);
 * Empfänger und IBAN kommen über ihn aus dem Mitgliederstamm – lässt er sich nicht zuordnen, wird das Mitglied gewählt –, der Betrag aus dem Betragsfeld des Belegs.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db, Verein } from '../verein.js';
import { paperless } from '../verein.js';
import { FOLGEAKTION_FELD, istUeberweisungEinreicher } from '../upload/logik.js';
import { zahlungBauen, type ZahlungDaten } from '../upload/zahlung.js';
import { belegAus, type OffenerBeleg } from './belege.js';

import { folgeText, optionWert, sapLeer, statusOffen } from './ueberweisung-regeln.js';

export { folgeText, sapLeer };

/** Custom Field „Status“ des Belegs: gelistet werden nur Belege mit „Offen“; die Bestätigung der Überweisung setzt „gezahlt“ */
export const STATUS_FELD = 'Status';
export const STATUS_GEZAHLT = 'gezahlt';

/** Status eines Belegs in Paperless auf „gezahlt“ setzen (Auswahlfeld: passende Option, sonst Text); liefert Warnungen */
export async function statusGezahltSetzen(v: Verein, id: number): Promise<string[]> {
  const pl = paperless(v);
  const f = await pl.feldDetails(STATUS_FELD);
  if (!f) throw new BusinessError(`Custom Field „${STATUS_FELD}“ fehlt in Paperless.`);
  let wert: string | number = STATUS_GEZAHLT;
  if (f.data_type === 'select') {
    const opts = f.extra_data?.select_options ?? [];
    const o = optionWert(opts, STATUS_GEZAHLT);
    if (o === null) throw new BusinessError(`Im Auswahlfeld „${STATUS_FELD}“ gibt es den Wert „${STATUS_GEZAHLT}“ nicht (vorhanden: ${opts.map((x) => (typeof x === 'string' ? x : x.label)).join(', ') || 'keine'}).`);
    wert = o;
  }
  return pl.metadatenSetzen(id, { customFields: { [String(f.id)]: wert } });
}

/**
 * Überweisung bestätigen: Status des Belegs in Paperless = „gezahlt“ (er verschwindet damit aus der Liste) und der Eintrag
 * im Arbeitsvorrat des Kassenwarts gilt als überwiesen.
 */
export async function ueberweisungBestaetigen(v: Verein, tx: Db, id: number, wer: string): Promise<{ text: string; hinweise: string[] }> {
  await ueberweisungDokument(v, id);
  const hinweise = await statusGezahltSetzen(v, id);
  await tx`update tco.upload_folge set erledigt_am = now(), erledigt_von = ${wer} where dok_id = ${id} and erledigt_am is null`;
  return { text: `Überweisung zu Beleg ${id} bestätigt – Status „${STATUS_GEZAHLT}“.`, hinweise };
}

/** Custom Field in Paperless mit dem Einreicher des Belegs */
export const EINREICHER_FELD = 'Eingereicht durch';

/** Einreicher aus dem Feld „Eingereicht durch“ des Dokuments (Text oder Auswahl); leer, wenn das Feld fehlt oder nicht gefüllt ist */
async function eingereichtDurch(v: Verein, d: Record<string, any>): Promise<string> {
  const pl = paperless(v);
  const f = await pl.feldDetails(EINREICHER_FELD);
  if (!f) return '';
  return folgeText(await pl.feldWert(d, String(f.id)), f.extra_data?.select_options ?? []).trim();
}

export interface UeberweisungBeleg extends OffenerBeleg { einreicher: string | null; hochgeladen: string | null; erledigt: boolean }

async function felder(v: Verein) {
  const pl = paperless(v);
  const folge = await pl.feldDetails(FOLGEAKTION_FELD);
  if (!folge) throw new BusinessError(`Das Custom Field „${FOLGEAKTION_FELD}“ gibt es in Paperless noch nicht – es entsteht mit dem ersten Dokumenten-Upload mit Folgeaktion.`);
  const sap = await pl.feld(v.fi_feld_sap);
  if (!sap) throw new BusinessError(`Custom Field „${v.fi_feld_sap}“ fehlt in Paperless.`);
  const status = await pl.feldDetails(STATUS_FELD);
  if (!status) throw new BusinessError(`Custom Field „${STATUS_FELD}“ fehlt in Paperless.`);
  return { pl, folge, sap, status, optionen: folge.extra_data?.select_options ?? [], statusOptionen: status.extra_data?.select_options ?? [] };
}

const passt = async (v: Verein, f: Awaited<ReturnType<typeof felder>>, d: Record<string, any>) =>
  istUeberweisungEinreicher(folgeText(await f.pl.feldWert(d, String(f.folge.id)), f.optionen)) && sapLeer(await f.pl.feldWert(d, v.fi_feld_sap))
  && statusOffen(folgeText(await f.pl.feldWert(d, String(f.status.id)), f.statusOptionen));

/** Belege mit Folgeaktion „Überweisung an Einreicher“, leerem Feld „SAP“ und Status „Offen“, neueste zuerst */
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
    out.push({ ...(await belegAus(v, d)), einreicher: (await eingereichtDurch(v, d)) || (u?.einreicher as string | undefined) || null, hochgeladen: (u?.am as string | undefined) ?? null, erledigt: !!u?.erledigt_am });
  }
  return out;
}

/** Zahlungsdaten und QR-Code zu einem dieser Belege; ohne Angabe gilt der Betrag aus dem Betragsfeld des Belegs */
export async function ueberweisungZahlung(v: Verein, db: Db, id: number, betrag: number | null, zweck: string | null, adrnr: string | null = null): Promise<ZahlungDaten> {
  const d = await ueberweisungDokument(v, id);
  const b = await belegAus(v, d);
  const [u] = await db`select einreicher, benutzer_id, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am from tco.upload_folge where dok_id = ${id} order by id desc limit 1`;
  const wert = betrag ?? (b.betrag != null && Math.abs(b.betrag) >= 0.01 ? Math.round(Math.abs(b.betrag) * 100) / 100 : null);
  // der Einreicher steht im Paperless-Feld „Eingereicht durch“; fehlt es, gilt der Benutzer des Dokumenten-Uploads
  const feld = await eingereichtDurch(v, d);
  return zahlungBauen(db, {
    id, titel: b.titel || `Beleg ${id}`, einreicher: feld || ((u?.einreicher as string | undefined) ?? ''), benutzer_id: feld ? null : (u?.benutzer_id as string | undefined) ?? null,
    dok_id: id, am: (u?.am as string | undefined) ?? b.datum ?? '',
  }, wert, zweck, adrnr);
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
