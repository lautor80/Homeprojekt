import { Pdf, type TextOpts } from '../../../../server/src/lib/pdfdoc.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { heute } from '../format.js';
import { C, fusszeile, kuerzen, LEFT, RIGHT, umbruch } from '../pdf/layout.js';
import { DB, logoWeiss, paperless, plAktiv, vereinLesen, type Db, type Verein } from '../verein.js';
import { K } from '../paperless-kontexte.js';
import { nichtErreichtLesen, zaehlerLesen, ZAEHLER_LEER, type NichtErreicht, type Zaehler } from './versand.js';

/**
 * Ausdruck eines Rundschreibens im TCO-Layout: Kopf (wer, wann, wie viele), Text, Anhänge, die nicht per E-Mail
 * Erreichten mit Anschrift (für Brief oder Aushang) und das Versandprotokoll je Empfänger. Dient als Voransicht zum
 * Drucken und als Beleg in Paperless.
 */
const UNTEN = 268;
const OBEN = 24;

interface Kopf {
  id: number; betreff: string; text: string; antwort_an: string | null; status: string; gesendet_am: string | null; gesendet_von: string | null;
  absender: string | null; fertig_am: string | null;
}
interface Zeile { namen: string; email: string | null; status: string; fehler: string | null; gesendet_am: string | null }

const STATUS_TEXT: Record<string, string> = { OFFEN: 'offen', SENDET: 'in Arbeit', GESENDET: 'gesendet', FEHLER: 'Fehler', OHNE_MAIL: 'ohne E-Mail-Adresse' };
const zeit = (ts: string | null) => (ts ? new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }) : '–');

export const rundschreibenTitel = (k: Pick<Kopf, 'id' | 'betreff'>) => `Rundschreiben ${k.id} – ${k.betreff}`.slice(0, 120);

class Druck {
  readonly p: Pdf;
  y = 0;

  constructor(readonly v: Verein, readonly titel: string) {
    this.p = new Pdf({ title: titel, author: v.name, creator: 'TCO Vereinsportal' });
    this.p.newPage();
  }

  txt(x: number, text: string, o: TextOpts = {}) { this.p.text(x, this.y, text, { size: 8, color: C.ink, ...o }); }
  platz(hoehe: number) { if (this.y + hoehe > UNTEN) { this.p.newPage(); this.y = OBEN; } }

  abschnitt(titel: string) {
    this.y += 4;
    this.platz(16);
    this.txt(LEFT, titel, { bold: true, color: C.orangeDk, size: 9 });
    this.p.line(LEFT, this.y + 2, RIGHT, this.y + 2, C.rand, 0.3);
    this.y += 7.5;
  }

  feld(label: string, wert: string) {
    this.platz(5.6);
    this.txt(LEFT + 2, label, { color: C.grau });
    this.txt(62, kuerzen(this.p, wert || '–', 8, 128));
    this.y += 5.6;
  }

  /** Fließtext mit Absätzen und Seitenwechsel */
  text(text: string) {
    for (const absatz of text.replace(/\r/g, '').split('\n')) {
      const zeilen = absatz.trim() ? umbruch(this.p, absatz, 9, 168) : [''];
      for (const z of zeilen) {
        this.platz(4.8);
        this.txt(LEFT + 2, z, { size: 9 });
        this.y += 4.8;
      }
    }
  }

  async render(): Promise<Buffer> {
    const n = this.p.pageCount();
    for (let s = 1; s <= n; s++) {
      this.p.setPage(s - 1);
      if (s > 1) {
        this.p.text(LEFT, 13, kuerzen(this.p, this.titel, 9, 120), { size: 9, bold: true, color: C.ink });
        this.p.text(RIGHT, 13, this.v.name, { size: 8, color: C.grau, align: 'R' });
        this.p.rect(LEFT, 15.5, 174, 0.6, { fill: C.orange });
      }
      fusszeile(this.p, this.v, s, n);
    }
    return this.p.render();
  }
}

export function rundschreibenDrucken(v: Verein, k: Kopf, z: Zaehler, anhaenge: string[], zeilen: Zeile[], nicht: NichtErreicht[]): Promise<Buffer> {
  const d = new Druck(v, rundschreibenTitel(k));
  d.p.rect(0, 0, 210, 46, { fill: C.orange });
  d.p.text(LEFT, 31, 'Rundschreiben', { size: 24, color: 'FFFFFF' });
  d.p.text(LEFT, 38.5, kuerzen(d.p, `${v.name} · Nr. ${k.id}${k.status === 'ENTWURF' ? ' · Entwurf (noch nicht gesendet)' : ''}`, 10, 115), { size: 10, color: 'FFFFFF' });
  d.p.image(logoWeiss(v), 137, 5.6, 57, 34.7);
  const kennzahl = (x: number, label: string, wert: string) => {
    d.p.text(x, 58, label, { size: 7, color: C.grau });
    d.p.text(x, 63, wert, { size: 9.5, bold: true, color: C.ink });
  };
  kennzahl(LEFT, 'Gesendet am', k.gesendet_am ? zeit(k.gesendet_am) : '–');
  kennzahl(78, 'E-Mails gesendet', `${z.gesendet} von ${z.gesamt}`);
  kennzahl(118, 'Fehler', String(z.fehler));
  kennzahl(142, 'ohne E-Mail-Adresse', String(z.ohne_mail));
  d.y = 72;

  d.abschnitt('Nachricht');
  d.feld('Betreff', k.betreff);
  d.feld('Gesendet von', k.gesendet_von ? `${k.gesendet_von}${k.absender ? ` (${k.absender})` : ''}` : '–');
  d.feld('Antwort an', k.antwort_an || k.absender || 'Absender');
  d.feld('Anhänge', anhaenge.length ? anhaenge.join(', ') : 'keine');
  d.y += 2;
  d.text(k.text);

  if (nicht.length) {
    d.abschnitt(`Nicht per E-Mail erreicht (${nicht.length}) – für Brief oder Aushang`);
    for (const n of nicht) {
      d.platz(5.6);
      d.txt(LEFT + 2, kuerzen(d.p, n.name, 8, 48));
      d.txt(70, kuerzen(d.p, [n.strasse, `${n.plz} ${n.ort}`.trim()].filter(Boolean).join(', ') || '–', 8, 58));
      d.txt(131, kuerzen(d.p, n.grund, 8, 60), { color: C.grau });
      d.y += 5.6;
    }
  }

  if (zeilen.length) {
    d.abschnitt(`Versandprotokoll (${zeilen.length})`);
    for (const e of zeilen) {
      d.platz(5.6);
      d.txt(LEFT + 2, kuerzen(d.p, e.namen, 8, 60));
      d.txt(82, kuerzen(d.p, e.email ?? '–', 8, 58));
      d.txt(143, kuerzen(d.p, e.status === 'GESENDET' ? `gesendet ${zeit(e.gesendet_am)}` : `${STATUS_TEXT[e.status] ?? e.status}${e.fehler && e.status === 'FEHLER' ? `: ${e.fehler}` : ''}`, 8, 48),
        { color: e.status === 'GESENDET' ? C.ink : C.orangeDk });
      d.y += 5.6;
    }
  }
  return d.render();
}

/** Ausdruck eines Rundschreibens aus der Datenbank */
export async function rundschreibenPdf(db: Db, id: number): Promise<{ pdf: Buffer; titel: string; kopf: Kopf; zaehler: Zaehler }> {
  const [k] = await db`select id, betreff, text, antwort_an, status, gesendet_am::text as gesendet_am, gesendet_von, absender, fertig_am::text as fertig_am
                         from tco.rundschreiben where id = ${id}`;
  if (!k) throw new BusinessError('Das Rundschreiben gibt es nicht (mehr).', 404);
  const kopf = k as unknown as Kopf;
  const zaehler = (await zaehlerLesen(db, [id])).get(id) ?? ZAEHLER_LEER;
  const anhaenge = (await db`select dateiname from tco.rundschreiben_anhaenge where rundschreiben_id = ${id} order by id`).map((a) => a.dateiname as string);
  const zeilen = await db`select namen, email, status, fehler, gesendet_am::text as gesendet_am from tco.rundschreiben_empfaenger
                           where rundschreiben_id = ${id} and status <> 'OHNE_MAIL' order by lower(namen), id`;
  const pdf = await rundschreibenDrucken(await vereinLesen(db), kopf, zaehler, anhaenge, zeilen as unknown as Zeile[], await nichtErreichtLesen(db, id));
  return { pdf, titel: rundschreibenTitel(kopf), kopf, zaehler };
}

/** Versendetes Rundschreiben als PDF in Paperless ablegen (Kontext „Rundschreiben“ der zentralen Zuordnung) und am Rundschreiben vermerken */
export async function rundschreibenAblegen(id: number, benutzer: string): Promise<{ id: number | null; titel: string; warnungen: string[] }> {
  const v = await vereinLesen();
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen).');
  const { pdf, titel, kopf, zaehler } = await rundschreibenPdf(DB, id);
  if (kopf.status === 'ENTWURF') throw new BusinessError('Abgelegt wird erst das gesendete Rundschreiben.');
  const werte = {
    titel, nummer: id, betreff: kopf.betreff, datum: (kopf.gesendet_am ?? '').slice(0, 10) || heute(), gesendet: zaehler.gesendet, fehler: zaehler.fehler,
    ohne_mail: zaehler.ohne_mail, verein: v.name, heute: heute(), benutzer,
  };
  const r = await kontextAblegen(paperless(v), K.rundschreiben, 'tco', werte, pdf, `${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf`, { benutzer });
  if (r.id) await DB`update tco.rundschreiben set paperless_id = ${r.id}, paperless_am = now() where id = ${id}`;
  return { id: r.id, titel, warnungen: r.warnungen };
}
