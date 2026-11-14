import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { condense, dat, heute, runden, zahl } from '../format.js';
import { paperless, plAktiv, type Db, type Verein } from '../verein.js';
import { dokuLesen, grenzen, gezahlt, monatsname, saetzeLesen, satzAm, type Doku } from './logik.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/**
 * Zeitnachweis Jugendtraining (interner Beleg) – Port von ZCL_TCO_JT_NACHWEIS.
 * Neutrales Layout ohne Logo und Vereinsfarbe. Ablage in Paperless:
 * Korrespondent „Nachname Vorname“, Speicherpfad „Buchhaltung“,
 * Dokumenttyp „Abrechnung Jugendtraining“, Neudruck = neue Version.
 */

export const DOKTYP = 'Abrechnung Jugendtraining';
export const SPEICHERPFAD = 'Buchhaltung';

const INK = '2B2B2B', GRAU = '888888', MGRAU = '555555', BAND = 'F1F1F1', ZEBRA = 'FAFAFA', LINIE = 'E2E2E2';
const XL = 20, XR = 190;

export interface Kopf {
  adrnr: string; monat: string; vorname: string; nachname: string; steuernummer: string; belegnr: string;
  saetze: number[]; stunden: number; betrag: number;
  gezahlt_am: string | null; neu_bezahlt: boolean; bisher_gez: number; bisher_am: string | null;
}
export interface Zeile { datum: string; bemerkung: string; stunden: number; satz: number; betrag: number }

const initiale = (s: string) => (s ? s.slice(0, 1).toUpperCase() : '');
const num = (v: number) => zahl(v);
const WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const wtag = (iso: string) => WT[new Date(`${iso}T12:00:00Z`).getUTCDay()];

/** Kopf und Zeilen aus den Rückmeldungen; Zahlstatus wie in SAP */
export async function nachweisDaten(db: Db, adrnr: string, monat: string, gezahltAm?: string | null): Promise<{ kopf: Kopf; zeilen: Zeile[]; alt: Doku | null }> {
  const { von, bis } = grenzen(monat);
  const rows = await db`select to_char(datum, 'YYYY-MM-DD') as datum, trainingsart, coalesce(anzahl, 0)::float8 as anzahl, zalias
                          from tco.jrueckm where adrnr = ${adrnr} and datum between ${von} and ${bis} and anzahl > 0
                         order by datum, trainingsart`;
  if (!rows.length) throw new BusinessError('Für diesen Trainer liegen im Monat keine Stunden vor.');
  const s = await saetzeLesen(db);
  const [m] = await db`select m.vorname, m.nachname, coalesce(a.steuernummer, '') as steuernummer
                         from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr where m.adrnr = ${adrnr}`;
  let vn = condense(m?.vorname ?? ''), nn = condense(m?.nachname ?? '');
  if (!nn) [vn, nn] = [condense(rows[rows.length - 1].zalias).split(' ')[0] ?? '', condense(rows[rows.length - 1].zalias).split(' ').slice(1).join(' ')];
  const seen = new Set<string>();
  const zeilen: Zeile[] = [];
  for (const r of rows) {
    const k = `${r.datum}|${r.trainingsart}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const satz = satzAm(s, adrnr, r.datum);
    zeilen.push({ datum: r.datum, bemerkung: r.trainingsart, stunden: Number(r.anzahl), satz, betrag: runden(Number(r.anzahl) * satz) });
  }
  const kopf: Kopf = {
    adrnr, monat, vorname: vn, nachname: nn, steuernummer: m?.steuernummer ?? '',
    belegnr: `${monat.slice(0, 4)}_${monat.slice(4, 6)}_TCO_${initiale(vn)}${initiale(nn)}`,
    saetze: [...new Set(zeilen.map((z) => z.satz))],
    stunden: runden(zeilen.reduce((x, z) => x + z.stunden, 0)),
    betrag: runden(zeilen.reduce((x, z) => x + z.betrag, 0)),
    gezahlt_am: null, neu_bezahlt: false, bisher_gez: 0, bisher_am: null,
  };
  // Zahlstatus: neu bezahlt / unverändert bezahlt / wiedereröffnet (Nachmeldung)
  const alt = await dokuLesen(db, adrnr, monat);
  const bisher = gezahlt(alt, kopf.betrag);
  if (gezahltAm) {
    kopf.gezahlt_am = gezahltAm;
    kopf.neu_bezahlt = true;
    if (bisher > 0 && bisher < kopf.betrag) { kopf.bisher_gez = bisher; kopf.bisher_am = alt?.bezahlt_am ?? null; }
  } else if (alt?.bezahlt_am && bisher >= kopf.betrag) {
    kopf.gezahlt_am = alt.bezahlt_am;
  } else if (bisher > 0) {
    kopf.bisher_gez = bisher; kopf.bisher_am = alt?.bezahlt_am ?? null;
  }
  return { kopf, zeilen, alt };
}

function tabellenkopf(p: Pdf, y0: number): number {
  const y = y0 + 4;
  const g = { size: 6.8, color: GRAU };
  p.text(22, y, 'DATUM', g);
  p.text(47, y, 'TAG', g);
  p.text(60, y, 'TRAININGSART', g);
  p.text(158, y, 'STD.', { ...g, align: 'R' });
  p.text(188, y, 'HONORAR €', { ...g, align: 'R' });
  p.line(XL, y + 1.8, XR, y + 1.8, INK, 0.3);
  return y + 7.5;
}

function feld(p: Pdf, x: number, y: number, label: string, wert: string) {
  p.text(x, y, label, { size: 6.5, color: GRAU });
  p.text(x, y + 4.5, wert, { size: 9.5, color: INK });
}

export async function nachweisPdf(v: Verein, k: Kopf, zeilen: Zeile[]): Promise<Buffer> {
  const p = new Pdf({ title: k.belegnr, author: v.name, creator: 'TCO Vereinsportal' });
  const monat = monatsname(k.monat);
  const name = condense(`${k.vorname} ${k.nachname}`);
  const { von, bis } = grenzen(k.monat);
  const jetzt = new Date();
  p.newPage();

  // Kopfzeile (kein Logo)
  p.text(XL, 17, `${v.name.toUpperCase()} · INTERNER BELEG`, { size: 7, color: GRAU });
  p.text(XR, 17, `BELEG-NR. ${k.belegnr}`, { size: 7, color: GRAU, align: 'R' });
  p.line(XL, 19, XR, 19, 'BBBBBB', 0.2);

  // Graues Band mit Titel und Eckdaten
  p.rect(XL, 23, 170, 45, { fill: BAND });
  p.text(25, 33, 'Zeitnachweis Jugendtraining', { size: 15, bold: true, color: INK });
  p.text(25, 38.5, 'Erstellt aus der Online-Zeitrückmeldung des Trainers', { size: 8.5, color: MGRAU });
  if (k.gezahlt_am) {
    p.rect(145, 27, 40, 8, { stroke: INK, lw: 0.4, radius: 1.5 });
    p.text(165, 32.4, `BEZAHLT ${dat(k.gezahlt_am)}`, { size: 8, bold: true, color: INK, align: 'C' });
  }
  feld(p, 25, 47, 'TRAINER (HONORARBASIS)', name);
  feld(p, 82, 47, 'MONAT', monat);
  feld(p, 139, 47, 'ZEITRAUM', `${dat(von)} – ${dat(bis)}`);
  feld(p, 25, 58, 'HONORAR JE STUNDE', k.saetze.map((x) => `${num(x)} €`).join(' / '));
  feld(p, 82, 58, 'STEUERNUMMER', k.steuernummer || '–');
  feld(p, 139, 58, 'ERSTELLT AM', `${dat(heute())} ${jetzt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })} Uhr`);

  // Positionen
  let y = tabellenkopf(p, 76);
  zeilen.forEach((z, i) => {
    if (y > 262) { p.newPage(); y = tabellenkopf(p, 17); }
    if (i % 2 === 1) p.rect(XL, y - 4.6, 170, 6.5, { fill: ZEBRA });
    const t = { size: 9, color: INK };
    p.text(22, y, dat(z.datum), t);
    p.text(47, y, wtag(z.datum), t);
    p.text(60, y, z.bemerkung, t);
    p.text(158, y, num(z.stunden), { ...t, align: 'R' });
    p.text(188, y, num(z.betrag), { ...t, align: 'R' });
    p.line(XL, y + 1.9, XR, y + 1.9, LINIE, 0.15);
    y += 6.5;
  });

  // Summenleiste
  if (y > 225) { p.newPage(); y = 20; }
  y += 2;
  p.line(XL, y, XR, y, INK, 0.3);
  p.line(XL, y + 14, XR, y + 14, INK, 0.3);
  p.line(76.7, y, 76.7, y + 14, 'CCCCCC', 0.15);
  p.line(133.3, y, 133.3, y + 14, 'CCCCCC', 0.15);
  const summe: [number, string, string][] = [[22, 'EINHEITEN', String(zeilen.length)], [79, 'STUNDEN', num(k.stunden)], [135.5, 'HONORAR GESAMT', `${num(k.betrag)} €`]];
  for (const [x, l, w] of summe) {
    p.text(x, y + 4.5, l, { size: 6.5, color: GRAU });
    p.text(x, y + 11, w, { size: 12, bold: true, color: INK });
  }
  y += 22;

  // Nachmeldung: bereits gezahlt / offen bzw. Restzahlung
  if (k.bisher_gez > 0) {
    const rest = runden(k.betrag - k.bisher_gez);
    const am = k.bisher_am ? ` am ${dat(k.bisher_am)}` : '';
    p.rect(XL, y - 6, 170, 9, { stroke: INK, lw: 0.3 });
    if (!k.gezahlt_am) {
      p.text(23, y, `Bereits gezahlt${am}: ${num(k.bisher_gez)} €`, { size: 9, color: INK });
      p.text(187, y, `Offen (Nachmeldung): ${num(rest)} €`, { size: 9, bold: true, color: INK, align: 'R' });
    } else {
      p.text(23, y, `Davon bereits gezahlt${am}: ${num(k.bisher_gez)} €`, { size: 9, color: INK });
      p.text(187, y, `Restzahlung am ${dat(k.gezahlt_am)}: ${num(rest)} €`, { size: 9, bold: true, color: INK, align: 'R' });
    }
    y += 11;
  }

  // Hinweistext
  y += p.textBlock(XL, y - 3, 170, 'Die aufgeführten Trainingszeiten hat der Trainer selbst geplant und über die Online-Zeiterfassung gemeldet. '
    + 'Der Nachweis gibt diese Rückmeldung unverändert wieder und dient der Dokumentation in den Vereinsunterlagen. Er ist keine Rechnung.',
  { size: 8.3, color: '444444', lineGap: 0.6 });

  // Ablagevermerk
  y += 10;
  p.text(XL, y, 'GEZAHLT AM', { size: 6.5, color: GRAU });
  p.text(78, y, 'FI-BELEG', { size: 6.5, color: GRAU });
  p.text(136, y, 'BEMERKUNG', { size: 6.5, color: GRAU });
  if (k.gezahlt_am) p.text(XL, y + 5.5, dat(k.gezahlt_am), { size: 9.5, bold: true, color: INK });
  p.line(XL, y + 7, 72, y + 7, '999999', 0.2);
  p.line(78, y + 7, 130, y + 7, '999999', 0.2);
  p.line(136, y + 7, XR, y + 7, '999999', 0.2);

  // Fußzeile auf allen Seiten
  const n = p.pageCount();
  for (let i = 0; i < n; i++) {
    p.setPage(i);
    p.text(XL, 288, `Zeitnachweis Jugendtraining · ${name} · ${monat}`, { size: 6.8, color: '999999' });
    p.text(XR, 288, `${k.belegnr} · Seite ${i + 1}/${n}`, { size: 6.8, color: '999999', align: 'R' });
  }
  return p.render();
}

function notizText(k: Kopf, alt: Doku | null, erst: boolean, benutzer: string): string {
  const akt = `${num(k.stunden)} Std., ${num(k.betrag)} €`;
  const am = k.bisher_am ? ` am ${dat(k.bisher_am)}` : '';
  const rest = runden(k.betrag - k.bisher_gez);
  let t: string;
  if (erst) t = `Zeitnachweis ${monatsname(k.monat)} erstellt und abgelegt: ${akt}.`;
  else if (k.neu_bezahlt && k.bisher_gez > 0) {
    t = `Restzahlung als bezahlt gekennzeichnet am ${dat(k.gezahlt_am)}: ${num(rest)} € (bereits gezahlt${am}: ${num(k.bisher_gez)} €, gesamt ${akt}). Neue Version mit Zahlvermerk.`;
  } else if (k.neu_bezahlt) t = `Als bezahlt gekennzeichnet am ${dat(k.gezahlt_am)} (${akt}). Neue Version mit Zahlvermerk.`;
  else if (k.bisher_gez > 0) {
    t = `Wiedereröffnet wegen nachträglich gemeldeter Stunden. Bisher gezahlt${am}: ${num(k.bisher_gez)} €. Neu: ${akt}, offen: ${num(rest)} €. Neue Version erzeugt, "Bezahlt" wieder offen.`;
  } else {
    t = `Neue Version (Neudruck): ${akt}${alt && alt.betrag > 0 && alt.betrag !== k.betrag ? `, bisher ${num(alt.betrag)} €` : ''}`
      + `${k.gezahlt_am ? `, Zahlvermerk vom ${dat(k.gezahlt_am)} bleibt` : ''}.`;
  }
  return `${t} – Portal ${benutzer}, ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`;
}

/**
 * Ablage in Paperless (Erstdruck: Upload + Metadaten, Neudruck: neue Version),
 * danach Verknüpfung in tco.jt_doku (Schreiben über `schreiben`, damit Änderungsbelege entstehen).
 */
export async function nachweisAblegen(
  db: Db, v: Verein, k: Kopf, alt: Doku | null, pdf: Buffer, benutzer: string,
  schreiben: (fn: (tx: Db) => Promise<void>) => Promise<void>,
  opts: { anlass?: string } = {},
): Promise<{ id: number; text: string; warnungen: string[] }> {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const pl = paperless(v);
  const datei = `${k.belegnr}.pdf`;
  let id = alt?.doc_id ?? null;
  if (!id) {
    const hit = (await pl.dokumenteSuchen({ title__iexact: k.belegnr }).catch(() => []))[0];
    if (hit?.id) id = Number(hit.id);
  }
  const erst = !id;
  if (id) {
    const task = await pl.uploadVersion(id, pdf, datei, `Neudruck ${dat(heute())}`);
    await pl.warteAufDokument(task, 15).catch(() => null);
  }
  const werte = { belegnr: k.belegnr, trainer: condense(`${k.nachname} ${k.vorname}`), monat: k.monat, betrag: k.betrag, stunden: k.stunden, heute: heute(), benutzer, verein: v.name };
  const nachtragWarn: string[] = [];
  if (!id) {
    const r = await kontextAblegen(pl, K.jtNachweis, 'tco', werte, pdf, datei, { benutzer });
    if (!r.id) throw new BusinessError('Hochgeladen, die DOKID ist aber noch nicht verfügbar – bitte in einer Minute erneut übertragen.');
    id = r.id;
    nachtragWarn.push(...r.warnungen);
  }
  const docId = id;
  const bezahltBetrag = k.neu_bezahlt ? k.betrag : gezahlt(alt, k.betrag);
  await schreiben(async (tx) => {
    await tx`insert into tco.jt_doku (adrnr, monat, belegnr, doc_id, erstellt_am, erstellt_um, erstellt_von, bezahlt_am, stunden, betrag, bezahlt_betrag)
             values (${k.adrnr}, ${k.monat}, ${k.belegnr}, ${docId}, current_date, localtime(0), ${benutzer},
                     ${k.neu_bezahlt ? k.gezahlt_am : alt?.bezahlt_am ?? null}, ${k.stunden}, ${k.betrag}, ${bezahltBetrag})
             on conflict (adrnr, monat) do update set belegnr = excluded.belegnr, doc_id = excluded.doc_id, erstellt_am = excluded.erstellt_am,
               erstellt_um = excluded.erstellt_um, erstellt_von = excluded.erstellt_von, bezahlt_am = excluded.bezahlt_am,
               stunden = excluded.stunden, betrag = excluded.betrag, bezahlt_betrag = excluded.bezahlt_betrag`;
  });
  const warnungen: string[] = [...nachtragWarn];
  const dokid = String(docId).padStart(6, '0');
  // Felder laut zentraler Paperless-Zuordnung (Kontext „Zeitnachweis Jugendtraining“)
  warnungen.push(...(await kontextAktualisieren(pl, K.jtNachweis, 'tco', docId, werte, { ohneNotiz: true })).warnungen);
  await pl.notizAnlegen(docId, `${opts.anlass ? `${opts.anlass}. ` : ''}${notizText(k, alt, erst, benutzer)}`).catch((e) => { warnungen.push(`Notiz: ${(e as Error).message}`); });
  // Freigabelink für die neueste Version vorbereiten (WhatsApp)
  await pl.neuesteVersion(docId).then((ver) => pl.freigabelink(ver, 30)).catch(() => undefined);
  const text = `${erst ? 'Zeitnachweis in Paperless abgelegt'
    : k.neu_bezahlt ? 'Als bezahlt gekennzeichnet, neue Version übertragen'
      : k.bisher_gez > 0 ? 'Nachmeldung: neue Version übertragen, „Bezahlt“ wieder offen'
        : 'Neue Version übertragen'} (DOKID ${dokid}).`;
  return { id: docId, text, warnungen };
}
