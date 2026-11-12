/**
 * Formular Schadensmeldung (#205) im TCO-Druckformat: Kopfband mit Logo, Anlass (Abschluss / Weitergabe), Eckdaten,
 * Beschreibung, Bearbeitung, Unterschriftsfelder, vollständiges Protokoll und die Fotos als Anlage.
 * Ablage in Paperless über den Kontext „Schadensmeldung“ (Vorgabewerte: Administration → Paperless-Zuordnung).
 */
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { logoWeiss, paperless, plAktiv, type Verein } from '../verein.js';
import { dat, heute } from '../format.js';
import { alleFusszeilen, betragText, C, kuerzen, LEFT, RIGHT, umbruch } from '../pdf/layout.js';
import { K } from '../paperless-kontexte.js';
import { ANLASS, type Anlass } from './regeln.js';

export interface FormularDaten {
  nummer: string; anlage: string; gruppe: string; kategorie: string; auswirkung_txt: string; status_txt: string;
  beschreibung: string; melder_name: string; eingang: Date | string; zustaendig_name: string | null;
  erledigung: string | null; kosten: number | null; firma: string | null; paperless: string | null; stunden: number | null;
  platz: string | null; sperre_id: number | null; sperre_von: string | null; duplikat_nummer: string | null; erledigt_am: Date | string | null;
  protokoll: { am: Date | string; von: string; aktion_txt: string; text: string | null }[];
}
export interface FormularFoto { art: string; name: string; mime: string; daten: Buffer; am: Date | string; von: string }
export interface FormularAngaben { anlass: Anlass; an?: string | null; bemerkung?: string | null; benutzer: string }

const zeitpunkt = (d: Date | string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const zeitGenau = (d: Date | string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Standardschriften kennen nur WinAnsi: Pfeil ersetzen, übrige Zeichen außerhalb (z. B. Emojis) weglassen */
const ws = (s: string) => s.replace(/→/g, '»').replace(/[^\u0000-\u00ff€–—„“”‚‘’•…‹›]/g, '');

export const formularTitel = (nummer: string) => `Schadensmeldung ${nummer}`;

export async function formularPdf(v: Verein, m: FormularDaten, fotos: FormularFoto[], a: FormularAngaben): Promise<Buffer> {
  const p = new Pdf({ title: formularTitel(m.nummer), author: v.name, creator: 'TCO Vereinsportal', subject: `${ANLASS[a.anlass]} ${m.nummer}` });
  const grau = { size: 7, color: C.grau };
  const UNTEN = 268;
  p.newPage();

  // ---- Kopfband
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 25, 'SCHADENSMELDUNG', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 33.5, `${m.nummer} · ${m.status_txt}`, { size: 13, color: 'FFFFFF' });
  p.text(LEFT, 40.5, `${ANLASS[a.anlass]}${a.anlass === 'WEITERGABE' && a.an ? ` an ${a.an}` : ''} · erstellt ${zeitpunkt(new Date())} von ${a.benutzer}`, { size: 8.5, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  // ---- Eckdaten
  let y = 54;
  const felder: [string, string][] = [
    ['WO', m.gruppe ? `${m.gruppe} · ${m.anlage}` : m.anlage],
    ['KATEGORIE', m.kategorie],
    ['AUSWIRKUNG', m.auswirkung_txt],
    ['STATUS', `${m.status_txt}${m.duplikat_nummer ? ` (Duplikat von ${m.duplikat_nummer})` : ''}${m.erledigt_am ? ` am ${zeitpunkt(m.erledigt_am)}` : ''}`],
    ['GEMELDET', `${zeitpunkt(m.eingang)} von ${m.melder_name}`],
    ['ZUSTÄNDIG', m.zustaendig_name ?? '–'],
    ['PLATZSPERRE', m.sperre_id ? `${m.platz} gesperrt seit ${dat(m.sperre_von)}` : m.platz ? `${m.platz} nicht gesperrt` : '–'],
    ['ANLASS', `${ANLASS[a.anlass]}${a.anlass === 'WEITERGABE' && a.an ? ` an ${a.an}` : ''}`],
  ];
  const zeilen = Math.ceil(felder.length / 2);
  p.rect(LEFT, y, 174, zeilen * 11 + 4, { fill: C.orangeSoft, radius: 3 });
  felder.forEach(([l, w], i) => {
    const x = LEFT + 5 + (i % 2) * 87;
    const yy = y + 6 + Math.floor(i / 2) * 11;
    p.text(x, yy, l, { size: 6.5, bold: true, color: C.orangeDk });
    p.text(x, yy + 5, kuerzen(p, w, 9.5, 80), { size: 9.5, bold: true, color: C.ink });
  });
  y += zeilen * 11 + 12;

  const abschnitt = (titel: string) => {
    if (y > UNTEN - 20) { p.newPage(); y = 20; }
    p.text(LEFT, y, titel, { size: 8, bold: true, color: C.orangeDk });
    p.line(LEFT, y + 1.5, RIGHT, y + 1.5, C.linie, 0.3);
    y += 6;
  };
  const absatz = (text: string, size = 9.5) => {
    const h = p.blockHeight(174, text, { size });
    if (y + h > UNTEN) { p.newPage(); y = 20; }
    y += p.textBlock(LEFT, y - 3, 174, text, { size, color: C.ink }) + 3;
  };

  abschnitt('BESCHREIBUNG');
  absatz(ws(m.beschreibung));

  abschnitt('BEARBEITUNG');
  const bearb: [string, string][] = [
    ['Erledigung / Ergebnis', m.erledigung || '–'],
    ['Kosten', m.kosten != null ? betragText(m.kosten) : '–'],
    ['Fremdfirma', m.firma || '–'],
    ['Angebot / Rechnung (Paperless)', m.paperless || '–'],
    ['Helferstunden', m.stunden != null ? `${m.stunden.toLocaleString('de-DE')} h` : '–'],
  ];
  for (const [l, w] of bearb) {
    const teile = umbruch(p, ws(w), 9, 120);
    if (y + teile.length * 4.5 > UNTEN) { p.newPage(); y = 20; }
    p.text(LEFT, y, l, grau);
    teile.forEach((t, i) => p.text(LEFT + 52, y + i * 4.5, t, { size: 9, color: C.ink }));
    y += Math.max(1, teile.length) * 4.5 + 1.5;
  }
  if (a.bemerkung?.trim()) {
    y += 2;
    abschnitt(a.anlass === 'WEITERGABE' ? 'HINWEISE ZUR WEITERGABE' : 'BEMERKUNG');
    absatz(ws(a.bemerkung.trim()));
  }

  // ---- Unterschriften
  if (y > UNTEN - 30) { p.newPage(); y = 20; }
  y += 6;
  const links = a.anlass === 'WEITERGABE' ? 'Übergeben (Verein)' : 'Erledigt durch';
  const rechts = a.anlass === 'WEITERGABE' ? `Übernommen${a.an ? ` (${kuerzen(p, a.an, 7, 50)})` : ''}` : 'Abgenommen (Vorstand)';
  for (const [x, t] of [[LEFT, links], [LEFT + 92, rechts]] as [number, string][]) {
    p.line(x, y + 12, x + 82, y + 12, C.rand, 0.3);
    p.text(x, y + 16, `Datum, Unterschrift – ${t}`, grau);
  }
  y += 26;

  // ---- Protokoll
  abschnitt('PROTOKOLL');
  const sp = { zeit: LEFT, wer: LEFT + 32, akt: LEFT + 66, text: LEFT + 92 };
  const kopf = () => {
    p.text(sp.zeit, y, 'ZEITPUNKT', grau); p.text(sp.wer, y, 'BENUTZER', grau); p.text(sp.akt, y, 'AKTION', grau); p.text(sp.text, y, 'TEXT', grau);
    y += 4.5;
  };
  kopf();
  for (const e of m.protokoll) {
    const teile = umbruch(p, ws(e.text ?? ''), 7.5, RIGHT - sp.text);
    const h = Math.max(1, teile.length) * 3.6 + 1.4;
    if (y + h > UNTEN) { p.newPage(); y = 20; kopf(); }
    p.text(sp.zeit, y, zeitGenau(e.am), { size: 7.5, color: C.ink });
    p.text(sp.wer, y, kuerzen(p, e.von, 7.5, 32), { size: 7.5, color: C.ink });
    p.text(sp.akt, y, kuerzen(p, e.aktion_txt, 7.5, 25), { size: 7.5, bold: true, color: C.ink });
    teile.forEach((t, i) => p.text(sp.text, y + i * 3.6, t, { size: 7.5, color: C.ink }));
    p.line(LEFT, y + h - 2.6, RIGHT, y + h - 2.6, C.linie, 0.15);
    y += h;
  }

  // ---- Fotos als Anlage (zwei je Seite)
  const bilder = fotos.filter((f) => f.mime === 'image/jpeg' || f.mime === 'image/png');
  bilder.forEach((f, i) => {
    if (i % 2 === 0) {
      p.newPage();
      p.rect(0, 0, 210, 14, { fill: C.orange });
      p.text(LEFT, 9.5, `ANLAGE FOTOS · ${m.nummer}`, { size: 11, bold: true, color: 'FFFFFF' });
    }
    const oben = i % 2 === 0 ? 22 : 150;
    p.rect(LEFT, oben, 174, 112, { fill: C.fuss, radius: 2 });
    try { p.image(f.daten, LEFT + 2, oben + 2, 170, 108); } catch { p.text(105, oben + 56, 'Foto kann nicht dargestellt werden', { size: 9, color: C.grau, align: 'C' }); }
    p.text(LEFT, oben + 117, `Foto ${i + 1} von ${bilder.length} · ${f.art === 'NACHHER' ? 'nach der Reparatur' : 'Schaden'} · ${zeitpunkt(f.am)} · ${f.von}`, grau);
  });
  if (fotos.length > bilder.length) {
    if (y > UNTEN - 8) { p.newPage(); y = 20; }
    p.text(LEFT, UNTEN, `${fotos.length - bilder.length} Foto(s) in einem nicht druckbaren Format sind nur im Portal zu sehen.`, grau);
  }

  alleFusszeilen(p, v);
  return p.render();
}

/**
 * Formular in Paperless ablegen: erstes Mal über den Kontext „Schadensmeldung“, danach als neue Version desselben Dokuments.
 * Liefert die Dokument-ID; Felder werden nach jeder Ablage laut Paperless-Zuordnung (neu) gesetzt.
 */
export async function formularAblegen(v: Verein, m: FormularDaten & { formular_doc_id: number | null }, pdf: Buffer, a: FormularAngaben)
  : Promise<{ id: number; warnungen: string[]; neu: boolean }> {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
  const pl = paperless(v);
  const datei = `${formularTitel(m.nummer).replace(/\s+/g, '_')}.pdf`;
  const werte = {
    nummer: m.nummer, anlage: m.anlage, gruppe: m.gruppe, kategorie: m.kategorie, auswirkung: m.auswirkung_txt, status: m.status_txt,
    anlass: `${ANLASS[a.anlass]}${a.anlass === 'WEITERGABE' && a.an ? ` an ${a.an}` : ''}`, empfaenger: a.an ?? '', melder: m.melder_name, zustaendig: m.zustaendig_name ?? '', kosten: m.kosten ?? '',
    eingang: new Date(m.eingang).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }), heute: heute(), benutzer: a.benutzer, verein: v.name,
  };
  const warnungen: string[] = [];
  let id = m.formular_doc_id;
  if (id) {
    const task = await pl.uploadVersion(id, pdf, datei, `${ANLASS[a.anlass]} ${dat(heute())}`);
    await pl.warteAufDokument(task, 15).catch(() => null);
    warnungen.push(...(await kontextAktualisieren(pl, K.ihMeldung, 'tco', id, werte, { benutzer: a.benutzer, ohneNotiz: true })).warnungen);
    await pl.notizAnlegen(id, `${ANLASS[a.anlass]}${a.an ? ` an ${a.an}` : ''}: neue Version (${m.status_txt}) – Portal ${a.benutzer}`).catch((e) => { warnungen.push(`Notiz: ${(e as Error).message}`); });
    return { id, warnungen, neu: false };
  }
  const r = await kontextAblegen(pl, K.ihMeldung, 'tco', werte, pdf, datei, { benutzer: a.benutzer });
  if (!r.id) throw new BusinessError('Hochgeladen, die Dokument-ID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
  id = r.id;
  warnungen.push(...r.warnungen);
  return { id, warnungen, neu: true };
}
