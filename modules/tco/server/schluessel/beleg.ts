/**
 * Hallenschlüssel (#215): Beleg „Ausgabe“ bzw. „Rückgabe“ im TCO-Druckformat mit Quittungsvermerk und Protokoll;
 * Ablage in Paperless über die Kontexte „Schlüsselausgabe“ / „Schlüsselrückgabe“ (Vorgaben: Administration → Paperless-Zuordnung).
 * Nach der Quittung wird derselbe Beleg als neue Version abgelegt.
 */
import { Pdf } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen, kontextAktualisieren } from '../../../../server/src/lib/paperless-mapping.js';
import { logoWeiss, paperless, plAktiv, type Verein } from '../verein.js';
import { dat, heute } from '../format.js';
import { alleFusszeilen, betragText, C, kuerzen, LEFT, RIGHT, umbruch } from '../pdf/layout.js';
import { K } from '../paperless-kontexte.js';

export interface BelegDaten {
  id: number; nummer: string; art: string; art_txt: string; adrnr: string; person: string; datum: string; schluessel_nr: string | null; pfand: number | null;
  zustand_txt: string | null; tco_name: string; status: string; status_txt: string; quittiert_am: Date | string | null; quittiert_von: string | null;
  quittung_txt: string | null; nachweis: string | null; rgnr: string | null; internenr: string | null; bemerkung: string | null; doc_id: number | null;
  protokoll: { am: Date | string; von: string; aktion_txt: string; text: string | null }[];
}

const zeitpunkt = (d: Date | string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
const zeitGenau = (d: Date | string) => new Date(d).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Standardschriften kennen nur WinAnsi: Pfeil ersetzen, übrige Zeichen außerhalb (z. B. Emojis) weglassen */
const ws = (s: string) => s.replace(/→/g, '»').replace(/−/g, '-').replace(/[^\u0000-ÿ€–—„“”‚‘’•…‹›]/g, '');

export const belegTitel = (m: { nummer: string; art: string }) => `Hallenschlüssel ${m.art === 'AUSGABE' ? 'Ausgabe' : 'Rückgabe'} ${m.nummer}`;

export async function belegPdf(v: Verein, m: BelegDaten, adresse: { strasse: string; plz: string; ort: string } | null, bedingungen: string, benutzer: string): Promise<Buffer> {
  const ausgabe = m.art === 'AUSGABE';
  const p = new Pdf({ title: belegTitel(m), author: v.name, creator: 'TCO Vereinsportal', subject: m.nummer });
  const grau = { size: 7, color: C.grau };
  const UNTEN = 268;
  p.newPage();
  p.rect(0, 0, 210, 46, { fill: C.orange });
  p.text(LEFT, 25, 'HALLENSCHLÜSSEL', { size: 24, color: 'FFFFFF' });
  p.text(LEFT, 33.5, `${ausgabe ? 'Ausgabe' : 'Rückgabe'} · ${m.nummer}`, { size: 13, color: 'FFFFFF' });
  p.text(LEFT, 40.5, `${m.status_txt} · erstellt ${zeitpunkt(new Date())} von ${ws(benutzer)}`, { size: 8.5, color: 'FFFFFF' });
  p.image(logoWeiss(v), 137, 5.6, 57, 34.7);

  let y = 54;
  const felder: [string, string][] = [
    [ausgabe ? 'EMPFÄNGER' : 'ZURÜCKGEGEBEN VON', m.person],
    ['ANSCHRIFT', adresse && (adresse.strasse || adresse.ort) ? `${adresse.strasse}, ${adresse.plz} ${adresse.ort}`.replace(/^, /, '') : '–'],
    [ausgabe ? 'AUSGEGEBEN AM' : 'ZURÜCKGEGEBEN AM', dat(m.datum)],
    [ausgabe ? 'AUSGEGEBEN VON (TCO)' : 'EMPFANGEN VON (TCO)', m.tco_name || '–'],
    ['PFAND', m.pfand != null ? betragText(m.pfand) : '–'],
    [ausgabe ? 'RECHNUNG' : 'GUTSCHRIFT', m.rgnr ? `Hallenrechnung ${m.rgnr}` : m.internenr ? `FI-Buchung ${m.internenr} (Kasse)` : '–'],
    ['SCHLÜSSELNUMMER', m.schluessel_nr || 'nicht nummeriert'],
    ausgabe ? ['VORGANG', m.nummer] : ['ZUSTAND', m.zustand_txt ?? '–'],
  ];
  p.rect(LEFT, y, 174, 4 * 11 + 4, { fill: C.orangeSoft, radius: 3 });
  felder.forEach(([l, w], i) => {
    const x = LEFT + 5 + (i % 2) * 87;
    const yy = y + 6 + Math.floor(i / 2) * 11;
    p.text(x, yy, l, { size: 6.5, bold: true, color: C.orangeDk });
    p.text(x, yy + 5, kuerzen(p, ws(w), 9.5, 80), { size: 9.5, bold: true, color: C.ink });
  });
  y += 4 * 11 + 12;

  const abschnitt = (titel: string) => {
    if (y > UNTEN - 20) { p.newPage(); y = 20; }
    p.text(LEFT, y, titel, { size: 8, bold: true, color: C.orangeDk });
    p.line(LEFT, y + 1.5, RIGHT, y + 1.5, C.linie, 0.3);
    y += 6;
  };
  const absatz = (text: string, size = 9) => {
    for (const zeile of ws(text).split('\n')) {
      const teile = umbruch(p, zeile, size, 174);
      if (y + teile.length * 4.4 > UNTEN) { p.newPage(); y = 20; }
      teile.forEach((t, i) => p.text(LEFT, y + i * 4.4, t, { size, color: C.ink }));
      y += Math.max(1, teile.length) * 4.4 + 0.8;
    }
    y += 2;
  };

  if (ausgabe) { abschnitt('SPIELREGELN ZUM HALLENSCHLÜSSEL'); absatz(bedingungen); }
  if (m.bemerkung) { abschnitt('BEMERKUNG'); absatz(m.bemerkung); }

  abschnitt(ausgabe ? 'QUITTUNG DES EMPFÄNGERS' : 'EMPFANGSBESTÄTIGUNG DES TCO');
  if (m.status === 'QUITTIERT') {
    p.rect(LEFT, y - 2, 174, 16, { fill: C.fuss, radius: 2 });
    p.text(LEFT + 4, y + 3, ausgabe ? 'Ich habe den Hallenschlüssel erhalten und die Spielregeln zur Kenntnis genommen.' : 'Der Hallenschlüssel wurde zurückgegeben und vom TCO entgegengenommen.', { size: 9, color: C.ink });
    p.text(LEFT + 4, y + 9, ws(`${m.quittung_txt ?? 'Quittiert'}${m.quittiert_von ? `: ${m.quittiert_von}` : ''}${m.quittiert_am ? ` am ${zeitGenau(m.quittiert_am)}` : ''}${m.nachweis ? ` · ${m.nachweis}` : ''}`), { size: 8, bold: true, color: C.ink });
    y += 20;
  } else {
    absatz(ausgabe ? 'Noch nicht quittiert – der Empfänger bestätigt den Erhalt online über den Link aus der E-Mail. Ersatzweise hier unterschreiben:' : 'Der Empfang ist noch nicht bestätigt.');
    p.line(LEFT, y + 10, LEFT + 82, y + 10, C.rand, 0.3);
    p.text(LEFT, y + 14, `Datum, Unterschrift – ${ausgabe ? 'Empfänger' : 'TCO'}`, grau);
    y += 22;
  }

  abschnitt('PROTOKOLL');
  for (const e of m.protokoll) {
    const teile = umbruch(p, ws(e.text ?? ''), 7.5, RIGHT - LEFT - 92);
    const h = Math.max(1, teile.length) * 3.6 + 1.4;
    if (y + h > UNTEN) { p.newPage(); y = 20; }
    p.text(LEFT, y, zeitGenau(e.am), { size: 7.5, color: C.ink });
    p.text(LEFT + 32, y, kuerzen(p, ws(e.von), 7.5, 32), { size: 7.5, color: C.ink });
    p.text(LEFT + 66, y, kuerzen(p, e.aktion_txt, 7.5, 25), { size: 7.5, bold: true, color: C.ink });
    teile.forEach((t, i) => p.text(LEFT + 92, y + i * 3.6, t, { size: 7.5, color: C.ink }));
    y += h;
  }
  alleFusszeilen(p, v);
  return p.render();
}

/** Beleg in Paperless ablegen: beim ersten Mal über den Kontext, danach als neue Version desselben Dokuments */
export async function belegAblegen(v: Verein, m: BelegDaten, pdf: Buffer, benutzer: string): Promise<{ id: number; warnungen: string[]; neu: boolean }> {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
  const pl = paperless(v);
  const def = m.art === 'AUSGABE' ? K.schluesselAusgabe : K.schluesselRueckgabe;
  const datei = `${belegTitel(m).replace(/\s+/g, '_')}.pdf`;
  const [vorname, ...rest] = m.person.split(' ');
  const werte = {
    nummer: m.nummer, person: rest.length ? `${rest.join(' ')} ${vorname}` : m.person, name: m.person, adrnr: m.adrnr, datum: m.datum, pfand: m.pfand ?? '',
    tco: m.tco_name, status: m.status_txt, rgnr: m.rgnr ?? '', schluessel_nr: m.schluessel_nr ?? '', heute: heute(), benutzer, verein: v.name,
  };
  const warnungen: string[] = [];
  if (m.doc_id) {
    const task = await pl.uploadVersion(m.doc_id, pdf, datei, `${m.status_txt} ${dat(heute())}`);
    await pl.warteAufDokument(task, 15).catch(() => null);
    warnungen.push(...(await kontextAktualisieren(pl, def, 'tco', m.doc_id, werte, { benutzer, ohneNotiz: true })).warnungen);
    return { id: m.doc_id, warnungen, neu: false };
  }
  const r = await kontextAblegen(pl, def, 'tco', werte, pdf, datei, { benutzer });
  if (!r.id) throw new BusinessError('Hochgeladen, die Dokument-ID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
  warnungen.push(...r.warnungen);
  return { id: r.id, warnungen, neu: true };
}
