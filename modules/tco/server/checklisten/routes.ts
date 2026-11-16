import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { DB, vereinLesen } from '../verein.js';
import {
  abhaken, bezugLoeschen, checklisteAendern, checklisteAnlegen, checklisteKopieren, checklisteLesen, checklisteLoeschen, checklistenLesen,
  eventsZuordnen, eventsZurAuswahl, kategorieLoeschen, kategorienLesen, kategorieSpeichern, personenLesen, schrittAendern, schrittAnlegen,
  schritteKopieren, schritteOrdnen, schrittLoeschen, STAND_TEXT, terminZuordnen, importAusfuehren, importLesen, IMPORT_SPALTEN, MAX_STUFEN, kategorieSetzen, schrittVerschieben,
} from './logik.js';
import { checklistePdf } from './pdf.js';

/**
 * Berechtigungsobjekte Checklisten:
 *  - tco.checklisten:display  Checklisten ansehen und als PDF drucken
 *  - tco.checklisten:edit     Checklisten und Kategorien pflegen, Veranstaltungen zuordnen, Schritte abhaken, kopieren, löschen
 */
export const P_CL = { display: 'tco.checklisten:display', edit: 'tco.checklisten:edit' };

const wer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';
const nr = z.coerce.number().int().positive();
const pId = z.object({ id: nr });
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const text = (max: number) => z.string().max(max).nullish();

const kopfSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte einen Titel angeben.').max(160), beschreibung: text(5000), kategorie_id: nr.nullish(),
  verantwortlich: text(120), verantwortlich_id: z.string().uuid().nullish(),
});
const schrittSchema = z.object({
  titel: z.string().trim().min(1, 'Bitte den Schritt benennen.').max(200), beschreibung: text(2000), verantwortlich: text(120),
  tage_vor: z.coerce.number().int().min(-365).max(730).nullish(), faellig: datum.nullish().or(z.literal('')),
  /** nur beim Anlegen: Unterschritt dieses Schritts */
  parent_id: nr.nullish(),
});

export async function checklistenRoutes(app: FastifyInstance) {
  const lesen = { preHandler: requireAuth(P_CL.display) };
  const pflege = { preHandler: requireAuth(P_CL.edit) };

  app.get('/checklisten', lesen, async (req) => ({
    checklisten: await checklistenLesen(DB), kategorien: await kategorienLesen(DB), personen: await personenLesen(DB),
    events: await eventsZurAuswahl(DB), stand_text: STAND_TEXT, import_spalten: IMPORT_SPALTEN, max_stufen: MAX_STUFEN, pflege: can(req, P_CL.edit),
  }));

  app.get('/checklisten/:id', lesen, async (req) => checklisteLesen(DB, pId.parse(req.params).id));

  app.post('/checklisten', pflege, async (req) => {
    const b = kopfSchema.parse(req.body);
    const id = await change(req, (tx) => checklisteAnlegen(tx, b, wer(req)), { action: 'CL_ANLEGEN' });
    return { id, text: `Checkliste „${b.titel}“ angelegt.` };
  });

  app.put('/checklisten/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = kopfSchema.parse(req.body);
    await change(req, (tx) => checklisteAendern(tx, id, b, wer(req)), { action: 'CL_AENDERN' });
    return { text: 'Gesichert.' };
  });

  app.delete('/checklisten/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => checklisteLoeschen(tx, id), { action: 'CL_LOESCHEN' });
    return { text: 'Checkliste gelöscht.' };
  });

  app.post('/checklisten/:id/kopieren', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ titel: text(160), bezuege: z.boolean().default(false) }).parse(req.body ?? {});
    const neu = await change(req, (tx) => checklisteKopieren(tx, id, b, wer(req)), { action: 'CL_KOPIEREN' });
    return { id: neu, text: 'Checkliste kopiert.' };
  });

  // ---------------------------------------------------------------- Schritte
  app.post('/checklisten/:id/schritte', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = schrittSchema.parse(req.body);
    return { id: await change(req, (tx) => schrittAnlegen(tx, id, b, wer(req)), { action: 'CL_SCHRITT' }) };
  });

  app.put('/checklisten/schritte/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = schrittSchema.parse(req.body);
    await change(req, (tx) => schrittAendern(tx, id, b, wer(req)), { action: 'CL_SCHRITT' });
    return { text: 'Gesichert.' };
  });

  app.delete('/checklisten/schritte/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => schrittLoeschen(tx, id, wer(req)), { action: 'CL_SCHRITT' });
    return { text: 'Schritt gelöscht.' };
  });

  app.post('/checklisten/:id/reihenfolge', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ schritte: z.array(nr).max(500) }).parse(req.body);
    await change(req, (tx) => schritteOrdnen(tx, id, b.schritte, wer(req)), { action: 'CL_SCHRITT' });
    return { text: 'Reihenfolge gesichert.' };
  });

  /** Schritte in eine andere Checkliste kopieren (zusammengehörige Themen) */
  app.post('/checklisten/schritte/kopieren', pflege, async (req) => {
    const b = z.object({ schritte: z.array(nr).min(1, 'Bitte mindestens einen Schritt wählen.').max(500), ziel: nr }).parse(req.body);
    const n = await change(req, (tx) => schritteKopieren(tx, b.schritte, b.ziel, wer(req)), { action: 'CL_KOPIEREN' });
    return { anzahl: n, text: `${n} Schritt${n === 1 ? '' : 'e'} kopiert.` };
  });

  // ---------------------------------------------------------------- Baum: Verschieben per Ziehen und Ablegen
  app.post('/checklisten/:id/kategorie', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ kategorie_id: nr.nullable() }).parse(req.body);
    await change(req, (tx) => kategorieSetzen(tx, id, b.kategorie_id, wer(req)), { action: 'CL_AENDERN' });
    return { text: 'Checkliste verschoben.' };
  });

  app.post('/checklisten/schritte/:id/verschieben', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    // vor = vor diesen Schritt (auf dessen Stufe); unter = als letzter Unterschritt dieses Schritts; beides leer = ans Ende der obersten Stufe
    const b = z.object({ ziel: nr, vor: nr.nullish(), unter: nr.nullish() }).parse(req.body);
    await change(req, (tx) => schrittVerschieben(tx, id, b.ziel, b.vor ?? null, wer(req), b.unter ?? null), { action: 'CL_SCHRITT' });
    return { text: 'Schritt verschoben.' };
  });

  // ---------------------------------------------------------------- Import aus der Zwischenablage
  /** Tabelle (aus Excel kopiert) prüfen bzw. übernehmen – übernommen wird nur, wenn keine Zeile einen Fehler hat */
  app.post('/checklisten/import', pflege, async (req) => {
    const b = z.object({ text: z.string().max(500_000), pruefen: z.boolean().default(true) }).parse(req.body);
    const g = importLesen(b.text);
    const schreiben = !b.pruefen && !g.fehler.length;
    const ergebnis = g.zeilen.length ? await change(req, (tx) => importAusfuehren(tx, g.zeilen, wer(req), schreiben), { action: 'CL_IMPORT' }) : null;
    return { fehler: g.fehler, kopfzeile: g.kopfzeile, zeilen: g.zeilen, ergebnis, uebernommen: schreiben && !!ergebnis };
  });

  // ---------------------------------------------------------------- Veranstaltungen / Termine
  app.post('/checklisten/:id/bezuege', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    const b = z.object({ events: z.array(nr).max(200).default([]), termin: datum.nullish(), bezeichnung: text(160) }).parse(req.body);
    if (!b.events.length && !b.termin) return { anzahl: 0, text: 'Nichts gewählt.' };
    const n = await change(req, async (tx) => {
      let k = b.events.length ? await eventsZuordnen(tx, id, b.events, wer(req)) : 0;
      if (b.termin) { await terminZuordnen(tx, id, { termin: b.termin, bezeichnung: b.bezeichnung }, wer(req)); k++; }
      return k;
    }, { action: 'CL_BEZUG' });
    return { anzahl: n, text: n ? `${n} Zuordnung${n === 1 ? '' : 'en'} angelegt.` : 'Die Veranstaltungen waren bereits zugeordnet.' };
  });

  app.delete('/checklisten/bezuege/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => bezugLoeschen(tx, id, wer(req)), { action: 'CL_BEZUG' });
    return { text: 'Zuordnung entfernt.' };
  });

  app.post('/checklisten/bezuege/:id/schritte/:schritt', pflege, async (req) => {
    const p = z.object({ id: nr, schritt: nr }).parse(req.params);
    const b = z.object({ erledigt: z.boolean(), notiz: text(500) }).parse(req.body);
    await change(req, (tx) => abhaken(tx, p.id, p.schritt, b, wer(req)), { action: 'CL_ABHAKEN' });
    return { text: b.erledigt ? 'Erledigt.' : 'Wieder offen.' };
  });

  // ---------------------------------------------------------------- Kategorien
  app.post('/checklisten/kategorien', pflege, async (req) => {
    const b = z.object({ id: nr.nullish(), name: z.string().trim().min(1, 'Bitte einen Namen angeben.').max(80), aktiv: z.boolean().default(true) }).parse(req.body);
    return { id: await change(req, (tx) => kategorieSpeichern(tx, b), { action: 'CL_KATEGORIE' }), text: 'Kategorie gesichert.' };
  });

  app.delete('/checklisten/kategorien/:id', pflege, async (req) => {
    const { id } = pId.parse(req.params);
    await change(req, (tx) => kategorieLoeschen(tx, id), { action: 'CL_KATEGORIE' });
    return { text: 'Kategorie gelöscht.' };
  });

  // ---------------------------------------------------------------- PDF
  app.get('/checklisten/:id/pdf', lesen, async (req, reply) => {
    const { id } = pId.parse(req.params);
    const q = z.object({ bezug: nr.optional() }).parse(req.query);
    const { pdf, titel } = await checklistePdf(DB, await vereinLesen(), id, q.bezug);
    return reply.type('application/pdf').header('content-disposition', `inline; filename="${titel.replace(/[^\wäöüÄÖÜß .()-]/g, '_')}.pdf"`).send(pdf);
  });
}
