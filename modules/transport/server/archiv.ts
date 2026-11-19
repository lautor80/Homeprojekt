import { sql, withChange, type ChangeContext } from '../../../server/src/db.js';
import { funktionAktiv } from '../../../server/src/funktionsschalter.js';
import { kontextAblegen } from '../../../server/src/lib/paperless-mapping.js';
import { fahrtenFuerVersand, firmaLesen } from './data.js';
import { paperlessFirma } from './dokumente.js';
import { condense } from './format.js';
import { paperlessSenden } from './paperless.js';
import { K } from './paperless-kontexte.js';
import { dokumentPdf } from './pdf/erzeugen.js';
import { rechnungPdf } from './pdf/rechnung.js';
import { ablegenNoetig, auftragAusKennung, belegAusDateiname, belegeEindeutig, belegName, belegText, type Anlass, type Beleg } from './archiv-logik.js';

/**
 * Belege beim Drucken und Versenden automatisch in Paperless ablegen – wenn Paperless für Euroflex eingerichtet ist
 * (Administration → Schnittstellen → Paperless) und die Funktion „Belege automatisch in Paperless ablegen“ an ist.
 *
 * - Felder laut zentraler Paperless-Zuordnung: Kontexte „Transportauftrag“, „Lieferschein“ und „Ausgangsrechnung“.
 * - Das abgelegte Dokument wird dem Auftrag zugeordnet (Reiter Dokumente; bei Sammelrechnungen jedem ihrer Aufträge).
 * - Ein Beleg wird nur erneut abgelegt, wenn sich der Auftrag seit der letzten Ablage geändert hat (Tabelle transport.paperless_belege).
 * - Die Ablage läuft im Hintergrund nacheinander ab; Drucken und Versenden warten nicht darauf und scheitern nicht daran.
 */
export const F_ARCHIV = 'transport.paperless.automatisch';

export interface AblageErgebnis { ok: boolean; status: 'aus' | 'aktuell' | 'abgelegt' | 'fehler'; message: string; id?: number | null }
type Log = { warn: (o: unknown, text: string) => void; info?: (o: unknown, text: string) => void };

export const paperlessEingerichtet = async () => { const f = await firmaLesen(); return !!(f.paperless_url && f.paperless_token); };
const kontaktName = (a: { kundenname?: string | null; kundenname2?: string | null } | null | undefined) => (a ? condense(`${a.kundenname ?? ''} ${a.kundenname2 ?? ''}`) : '');

/** Aufträge des Belegs (Rechnung: alle Aufträge der Faktura) */
async function auftraegeZu(b: Beleg): Promise<string[]> {
  if (b.art === 'R') return (await sql`select auftragsnr from transport.auftraege where faktura = ${b.kennung} order by auftragsnr`).map((r) => r.auftragsnr as string);
  const nr = auftragAusKennung(b.kennung);
  const [da] = await sql`select auftragsnr from transport.auftraege where auftragsnr = any(${[b.kennung, nr]}) limit 1`;
  return da ? [da.auftragsnr as string] : [];
}

/**
 * Änderungsstand der Aufträge: jüngste Änderung laut Änderungsbelegen (Auftrag, Stops, Träger, Fahrten – ohne die
 * Zuordnung von Dokumenten, die die Ablage selbst schreibt) bzw. updated_at (Datenimport).
 */
async function standLesen(auftraege: string[]): Promise<Date | null> {
  if (!auftraege.length) return null;
  const [r] = await sql`
    select greatest(
      (select max(changed_at) from core.change_header where object_type = 'AUFTRAG' and object_key = any(${auftraege}) and table_name <> 'transport.auftrag_dokumente'),
      (select max(updated_at) from transport.auftraege where auftragsnr = any(${auftraege}))
    ) as stand`;
  return (r?.stand as Date | null) ?? null;
}

/**
 * Einen Beleg ablegen. `pdf`: die gedruckte/versendete Datei (sonst wird sie erzeugt). `erzwingen`: auch ohne Änderung
 * (Knopf „Versenden → Paperless“).
 */
export async function belegAblegen(b: Beleg, o: { anlass: Anlass; ctx: ChangeContext; benutzer: string; pdf?: Buffer; erzwingen?: boolean }): Promise<AblageErgebnis> {
  const firma = await firmaLesen();
  if (!firma.paperless_url || !firma.paperless_token) return { ok: false, status: 'aus', message: 'Paperless ist nicht eingerichtet (Administration → Schnittstellen: Adresse und API-Token).' };
  const auftraege = await auftraegeZu(b);
  if (!auftraege.length) return { ok: false, status: 'fehler', message: `${belegText(b)}: kein Auftrag gefunden.` };
  const stand = (await standLesen(auftraege)) ?? new Date();
  const [bisher] = await sql`select stand, doc_id from transport.paperless_belege where art = ${b.art} and kennung = ${b.kennung}`;
  if (!ablegenNoetig(bisher as { stand: Date } | undefined, stand, o.erzwingen)) {
    return { ok: true, status: 'aktuell', id: (bisher?.doc_id as number | null) ?? null, message: `${belegText(b)} liegt in diesem Stand schon in Paperless${bisher?.doc_id ? ` (Dokument ${bisher.doc_id})` : ''}.` };
  }
  // Stand vormerken, bevor hochgeladen wird – ein zweiter Druck zur selben Zeit legt nicht doppelt ab
  const vorgemerkt = await sql`
    insert into transport.paperless_belege (art, kennung, stand, anlass, abgelegt_von) values (${b.art}, ${b.kennung}, ${stand}, ${o.anlass}, ${o.benutzer})
    on conflict (art, kennung) do update set stand = excluded.stand, anlass = excluded.anlass, abgelegt_von = excluded.abgelegt_von, abgelegt_am = now(), doc_id = null
     where ${!!o.erzwingen} or transport.paperless_belege.stand < excluded.stand
    returning 1`;
  if (!vorgemerkt.length) return { ok: true, status: 'aktuell', message: `${belegText(b)} wird gerade schon abgelegt.` };
  const zuruecknehmen = async () => {
    if (bisher) await sql`update transport.paperless_belege set stand = ${bisher.stand}, doc_id = ${bisher.doc_id} where art = ${b.art} and kennung = ${b.kennung}`;
    else await sql`delete from transport.paperless_belege where art = ${b.art} and kennung = ${b.kennung}`;
  };

  try {
    let id: number | null | undefined;
    let titel = belegText(b);
    let hinweis = '';
    const heute = new Date().toISOString().slice(0, 10);
    if (b.art === 'R') {
      const r = await rechnungPdf(b.kennung);
      if (!r) throw new Error(`Rechnung ${b.kennung} nicht gefunden.`);
      const e = await paperlessSenden(firma, o.pdf ? { ...r, pdf: o.pdf } : r, o.benutzer);
      if (!e.ok) throw new Error(e.message);
      id = e.id;
      titel = r.title || titel;
    } else {
      const { auftrag: a } = (await fahrtenFuerVersand(b.kennung))[0];
      const pdf = o.pdf ?? (await dokumentPdf(b.art, b.kennung)).pdf;
      const datei = belegName(b);
      const r = await kontextAblegen(paperlessFirma(firma), b.art === 'T' ? K.transportauftrag : K.lieferschein, 'transport', {
        kennung: b.kennung, auftragsnr: a.auftragsnr, kunde: kontaktName(a.kundeAdr), unternehmer: kontaktName(a.unternehmerAdr),
        kennzeichen: a.kennzeichen ?? '', ordernummer: a.ordernummer ?? '', leistungsdatum: a.leistungsdatum ?? '',
        anlass: o.anlass === 'druck' ? 'Druck' : 'Versand', datei, heute, benutzer: o.benutzer,
      }, pdf, datei, { mime: 'application/pdf', benutzer: o.benutzer });
      id = r.id;
      titel = r.zuordnung.title || titel;
      if (r.warnungen.length) hinweis = ` Hinweis: ${r.warnungen.join('; ')}`;
    }
    await sql`update transport.paperless_belege set doc_id = ${id ?? null} where art = ${b.art} and kennung = ${b.kennung}`;
    if (id) {
      // im Auftrag unter „Dokumente“ sichtbar – bei einer Sammelrechnung in jedem ihrer Aufträge
      await withChange({ ...o.ctx, action: 'DOKUMENT_ABLEGEN' }, (tx) => tx`
        insert into transport.auftrag_dokumente (auftragsnr, doc_id, titel, datei, erstellt_von)
        select x, ${id}, ${titel}, ${belegName(b)}, ${o.benutzer} from unnest(${auftraege}::text[]) as x
        on conflict do nothing`);
    }
    return id
      ? { ok: true, status: 'abgelegt', id, message: `${belegText(b)} in Paperless abgelegt (Dokument ${id}).${hinweis}` }
      : { ok: true, status: 'abgelegt', id: null, message: `${belegText(b)} an Paperless übergeben – Verarbeitung läuft noch.${hinweis}` };
  } catch (e) {
    await zuruecknehmen().catch(() => undefined);
    return { ok: false, status: 'fehler', message: `${belegText(b)} nicht in Paperless abgelegt: ${(e as Error).message}` };
  }
}

// Warteschlange: Ablagen laufen nacheinander (Paperless wartet je Datei auf die Verarbeitung)
let kette: Promise<unknown> = Promise.resolve();

/**
 * Belege im Hintergrund ablegen (Drucken, Versenden). Gibt sofort zurück, wie viele Belege eingeplant sind;
 * 0, wenn Paperless nicht eingerichtet oder die Funktion abgeschaltet ist.
 */
export async function belegeImHintergrund(belege: (Beleg & { pdf?: Buffer })[], o: { anlass: Anlass; ctx: ChangeContext; benutzer: string; log: Log }): Promise<number> {
  const liste = belegeEindeutig(belege);
  if (!liste.length || !funktionAktiv(F_ARCHIV) || !(await paperlessEingerichtet())) return 0;
  kette = kette.then(async () => {
    for (const b of liste) {
      const r = await belegAblegen(b, { anlass: o.anlass, ctx: { ...o.ctx, sitzung: null }, benutzer: o.benutzer, pdf: b.pdf }).catch((e: Error) => ({ ok: false, status: 'fehler', message: e.message }) as AblageErgebnis);
      if (r.status === 'fehler') o.log.warn({ beleg: b, anlass: o.anlass }, `Paperless-Ablage: ${r.message}`);
      else if (r.status === 'abgelegt') o.log.info?.({ beleg: b, anlass: o.anlass }, `Paperless-Ablage: ${r.message}`);
    }
  }).catch((e) => o.log.warn(e, 'Paperless-Ablage abgebrochen'));
  return liste.length;
}

/** Versendete Anhänge, die Belege des Portals sind (Dateiname „Transportauftrag_…“, „Lieferschein_…“, „Rechnung_…“) – mit der gesendeten Datei */
export function versendeteBelege(dateien: { name: string; daten: Buffer }[]): (Beleg & { pdf: Buffer })[] {
  return dateien.flatMap((d) => { const b = belegAusDateiname(d.name); return b ? [{ ...b, pdf: d.daten }] : []; });
}

/** Wartet, bis die Warteschlange abgearbeitet ist (für Tests) */
export const ablageFertig = () => kette;
