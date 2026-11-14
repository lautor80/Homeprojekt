import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../auth.js';
import { BusinessError } from '../errors.js';
import { verbindungDef, verbindungsGruppen } from '../modules.js';
import { eingerichtet, istPaperlessId, maskieren, paperlessEindeutig, uebernehmen, verbindungLesen, verbindungSpeichern, type AuthArt } from '../lib/verbindungen.js';
import { offeneStoerungen, stoerungSchluessel } from '../lib/hinweise.js';

/** Rechnername der ersten Adresse – so benennt der Paperless-Client seinen Zugang in Störungsmeldungen (lib/paperless.ts, wo()) */
function rechner(url: string): string {
  const erste = url.split(',')[0].trim().replace(/\/+$/, '');
  try { return new URL(erste).host; } catch { return erste; }
}

/** Zentrale Anbindungen (Administration → Schnittstellen): angeschlossene Systeme des Kerns und der Module */
const P = 'core.settings:edit';

const eingabe = z.object({
  url: z.string().max(1000).nullish(),
  auth_art: z.enum(['keine', 'token', 'header', 'basic']).nullish(),
  auth_user: z.string().max(200).nullish(),
  header_name: z.string().max(80).regex(/^[A-Za-z0-9-]*$/, 'Header-Name: nur Buchstaben, Ziffern und Bindestrich').nullish(),
  geheimnis: z.string().max(4000).nullish(),
  einstellungen: z.record(z.string().max(60), z.unknown()).nullish(),
});

export async function verbindungenRoutes(app: FastifyInstance) {
  /** alle Anbindungen mit Definition und gespeicherten (maskierten) Werten */
  app.get('/api/verbindungen', { preHandler: requireAuth(P) }, async () => {
    const gruppen = [];
    // Zeile „Stand“ (#232, S1): offene Störungen aus dem Arbeitsvorrat – eine Quelle, zwei Anzeigen
    const stoerungen = await offeneStoerungen(['SCHNITTSTELLE', 'PAPERLESS', 'MAIL_FEHLER']);
    for (const g of verbindungsGruppen()) {
      const verbindungen = [];
      for (const d of g.verbindungen) {
        const roh = await verbindungLesen(d.id);
        const v = maskieren(roh);
        const { pruefen, ...def } = d;
        // Paperless meldet je Zugang (Rechnername der ersten Adresse), der E-Mail-Versand des Portals jede nicht gesendete E-Mail,
        // alle anderen Anbindungen der Module melden mit ihrer Id (tcoSchnittstelle)
        const s = !eingerichtet(roh) ? null
          : istPaperlessId(d.id) ? stoerungen.get(stoerungSchluessel('core', 'PAPERLESS', rechner(roh.url)))
            : d.id === 'mail' ? stoerungen.get(stoerungSchluessel('core', 'MAIL_FEHLER'))
              : stoerungen.get(stoerungSchluessel(g.modul, 'SCHNITTSTELLE', d.id));
        const stand = !eingerichtet(roh) ? { eingerichtet: false, gestoert: false, text: 'nicht eingerichtet', seit: null, anzahl: 0 }
          : s ? { eingerichtet: true, gestoert: true, ...s } : { eingerichtet: true, gestoert: false, text: 'keine Störung gemeldet', seit: null, anzahl: 0 };
        verbindungen.push({ ...def, pruefbar: !!pruefen, stand, werte: { ...v, auth_art: v.url || v.geheimnis ? v.auth_art : (d.auth[0] as AuthArt) } });
      }
      gruppen.push({ modul: g.modul, name: g.name, verbindungen });
    }
    return { gruppen };
  });

  app.put('/api/verbindungen/:id', { preHandler: requireAuth(P) }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const t = verbindungDef(id);
    if (!t) throw new BusinessError('Anbindung nicht gefunden.', 404);
    const e = eingabe.parse(req.body);
    const alt = await verbindungLesen(id);
    const neu = uebernehmen(t.def, alt, e);
    // Paperless je Bereich (#232, S5): nie dieselbe Adresse wie ein anderer Bereich
    if (istPaperlessId(id)) await paperlessEindeutig(neu);
    await change(req, (tx) => verbindungSpeichern(tx, neu, req.user?.username ?? 'system'));
    return maskieren(await verbindungLesen(id));
  });

  /** Verbindungstest mit den Formularwerten (Maske = gespeichertes Geheimnis), ohne zu speichern */
  app.post('/api/verbindungen/:id/pruefen', { preHandler: requireAuth(P) }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const t = verbindungDef(id);
    if (!t) throw new BusinessError('Anbindung nicht gefunden.', 404);
    if (!t.def.pruefen) return { ok: false, text: 'Für diese Anbindung gibt es keinen Verbindungstest.', dauer_ms: 0 };
    const e = eingabe.parse(req.body ?? {});
    const v = uebernehmen(t.def, await verbindungLesen(id), e);
    const start = Date.now();
    try {
      const r = await t.def.pruefen(v);
      return { ...r, dauer_ms: Date.now() - start };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      // fetch meldet nur „fetch failed“ – die Ursache (ECONNREFUSED, Timeout …) steht in cause
      const grund = e.cause?.code || e.cause?.message || '';
      const text = /fetch failed|aborted|timeout/i.test(e.message) ? `Nicht erreichbar${grund ? ` (${grund})` : ''}.` : e.message || 'Nicht erreichbar.';
      return { ok: false, text, dauer_ms: Date.now() - start };
    }
  });
}
