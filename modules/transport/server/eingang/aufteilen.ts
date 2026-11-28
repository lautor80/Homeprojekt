/**
 * Euroflex Posteingang – PDF von Hand aufteilen, Aufteilung zurücknehmen, Seitenvorschlag (Prüfliste, „Aufteilen…“).
 * Geteilt wird nur, solange noch kein Teil am Auftrag liegt. Das Original bleibt immer unverändert im Portal.
 * Regeln: rechnungspruefung.ts; Werkzeuge: rechnung.ts. Doku: docs/euroflex-mailworkflows.md, „Eingangsrechnungen“.
 */
import { sql } from '../../../../server/src/db.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { pdfSeitenTexte } from '../../../../server/src/lib/texterkennung.js';
import { istPdf } from '../../../../server/src/pdf.js';
import { workflowEinstellungen } from '../mailworkflows.js';
import { analyseOptionen, pdfAnalysieren } from './rechnung.js';
import { aufteilung, seitenEinordnen, type Seite, type Seitenart } from './rechnungspruefung.js';
import { abschliessen, firmierungMelden, teilAnlegen } from './verarbeitung.js';

const OFFEN = ['neu', 'fehler'];

async function dokumentLesen(id: number) {
  const [d] = await sql`
    select id::int as id, vorgang_id::int as vorgang_id, datei, mime, status, rolle, teil_von, inhalt, seiten
      from transport.eing_dokumente where id = ${id}`;
  if (!d) throw new BusinessError('Das Dokument gibt es nicht (mehr).', 404);
  if (d.teil_von) throw new BusinessError('Das ist bereits ein Teil – bitte das Original aufteilen.');
  if (!istPdf(d.mime as string | null, d.datei as string)) throw new BusinessError('Nur PDFs lassen sich aufteilen.');
  if (!d.inhalt) throw new BusinessError('Der Inhalt liegt nicht mehr im Portal.');
  const teile = await sql`select id::int as id, status from transport.eing_dokumente where teil_von = ${id} order by id`;
  const original = d.rolle === 'original';
  if (original ? teile.some((t) => !OFFEN.includes(t.status as string)) : !OFFEN.includes(d.status as string)) {
    throw new BusinessError(original ? 'Ein Teil liegt schon am Auftrag oder ist ignoriert – die Aufteilung lässt sich nicht mehr ändern.' : 'Das Dokument ist schon erledigt.');
  }
  return { d, teile, original, daten: Buffer.from(d.inhalt as string, 'base64') };
}

/** Vormerkung aufheben: die vorgemerkten Dateien gibt es nach einer Aufteilung so nicht mehr */
const vormerkungLoesen = (vorgangId: number) => sql`
  update transport.eing_vorgaenge set vorgemerkt_am = null, vorgemerkt_von = null, vorgemerkt_dokumente = null where id = ${vorgangId}`;

/** Einordnung je Seite als Vorschlag für den Dialog – gespeichert, sonst jetzt gelesen */
export async function seitenVorschlag(id: number): Promise<{ id: number; datei: string; seiten: Seite[]; aufgeteilt: boolean }> {
  const { d, original, daten } = await dokumentLesen(id);
  let seiten = Array.isArray(d.seiten) ? (d.seiten as Seite[]) : null;
  if (!seiten) {
    const st = await pdfSeitenTexte(daten);
    if (!st) throw new BusinessError('Das PDF lässt sich nicht seitenweise lesen (defekt, geschützt oder mehr als 40 Seiten).');
    seiten = seitenEinordnen(st.seiten);
    await sql`update transport.eing_dokumente set seiten = ${sql.json(seiten as never)} where id = ${id}`;
  }
  return { id, datei: d.datei as string, seiten, aufgeteilt: original };
}

/** PDF nach der Einordnung des Benutzers aufteilen (ersetzt eine frühere Aufteilung) */
export async function vonHandAufteilen(id: number, arten: Seitenart[], wer: string) {
  const { d, daten, original } = await dokumentLesen(id);
  const e = (await workflowEinstellungen()).eingang;
  const an = await pdfAnalysieren(d.datei as string, daten, { ...(await analyseOptionen(e)), arten });
  if (!an || !an.teile.length) throw new BusinessError('Es ist kein Teil entstanden – bitte die Einordnung prüfen.');
  const vorgang = d.vorgang_id as number;
  if (original) await sql`delete from transport.eing_dokumente where teil_von = ${id}`;
  await sql`update transport.eing_dokumente set status = 'ignoriert', rolle = 'original', pruefung = ${an.pruefung ? sql.json(an.pruefung as never) : null}, hinweis = ${an.hinweis}, seiten = ${sql.json(an.seiten as never)},
                   bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  for (const t of an.teile) await teilAnlegen(vorgang, id, t);
  await vormerkungLoesen(vorgang);
  await firmierungMelden(vorgang, false);
  const status = await abschliessen(vorgang);
  return { status, teile: an.teile.map((t) => t.datei), text: `Aufgeteilt in ${an.teile.map((t) => `„${t.datei}“`).join(' und ')}${an.auf.transportauftrag.length ? ' – Transportauftrag entfernt' : ''}. Das Original bleibt im Portal.` };
}

/** Aufteilung zurücknehmen: die Teile entfallen, das Original steht wieder als ein Dokument offen */
export async function aufteilungZuruecknehmen(id: number, wer: string) {
  const { d, original } = await dokumentLesen(id);
  if (!original) throw new BusinessError('Das Dokument ist nicht aufgeteilt.');
  const vorgang = d.vorgang_id as number;
  const rolle = Array.isArray(d.seiten) ? aufteilung(d.seiten as Seite[]).rolle : null;
  await sql`delete from transport.eing_dokumente where teil_von = ${id}`;
  await sql`update transport.eing_dokumente set status = 'neu', rolle = ${rolle}, hinweis = null, bearbeitet_am = now(), bearbeitet_von = ${wer} where id = ${id}`;
  await vormerkungLoesen(vorgang);
  await firmierungMelden(vorgang, false);
  return { status: await abschliessen(vorgang), text: 'Aufteilung zurückgenommen – das Dokument steht wieder als Ganzes in der Liste.' };
}
