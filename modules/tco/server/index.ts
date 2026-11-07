import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { asset, DB, paperless, plAktiv, vereinLesen } from './verein.js';
import { ausfuehren, pruefen, TABELLEN } from './importer.js';
import { halleRoutes, P_HALLE } from './halle/routes.js';
import { fiRoutes, P_FI } from './fi/routes.js';

const P = {
  stammdaten: 'tco.stammdaten:edit',
  import: 'tco.import:execute',
};

const MASKE = '********';
const GEHEIM = ['paperless_token', 'n8n_mail_key', 'n8n_ep3_auth'] as const;

const vereinSchema = z.object({
  name: z.string().trim().min(1, 'Bitte den Vereinsnamen angeben').max(70),
  strasse: z.string().nullish(), plz_ort: z.string().nullish(),
  iban: z.string().nullish().transform((v) => v?.replace(/\s/g, '').toUpperCase() || null),
  bic: z.string().nullish(), bank: z.string().nullish(), steuernr: z.string().nullish(),
  ansprechpartner: z.string().nullish(), email: z.string().nullish(),
  zahlungsziel_tage: z.coerce.number().int().min(0).max(90),
  logo: z.string().nullish(),
  paperless_url: z.string().nullish(), paperless_token: z.string().nullish(),
  n8n_mail_url: z.string().nullish(), n8n_mail_key: z.string().nullish(),
  n8n_ep3_url: z.string().nullish(), n8n_ep3_auth: z.string().nullish(),
  halle_stichtag: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  halle_ausschluss: z.string().default(''),
  fi_bankkonten: z.string().optional(),
  fi_manuell_konten: z.string().optional(),
  fi_beleg_typen: z.string().optional(),
  fi_beleg_pfad: z.string().optional(),
  fi_feld_beleg: z.string().trim().min(1).optional(),
  fi_feld_betrag: z.string().trim().min(1).optional(),
  fi_feld_sap: z.string().trim().min(1).optional(),
});

async function routes(app: FastifyInstance) {
  app.get('/verein', { preHandler: requireAuth() }, async () => {
    const v = await vereinLesen();
    const out: Record<string, unknown> = { ...v };
    for (const g of GEHEIM) out[g] = v[g] ? MASKE : '';
    return out;
  });

  app.put('/verein', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const d = vereinSchema.parse(req.body);
    const alt = await vereinLesen();
    for (const g of GEHEIM) if (d[g] === MASKE) d[g] = alt[g];
    const FI = ['fi_bankkonten', 'fi_manuell_konten', 'fi_beleg_typen', 'fi_beleg_pfad', 'fi_feld_beleg', 'fi_feld_betrag', 'fi_feld_sap'] as const;
    for (const k of FI) if (d[k] === undefined) d[k] = alt[k];
    await change(req, (tx) => tx`
      update tco.verein set name = ${d.name}, strasse = ${d.strasse ?? null}, plz_ort = ${d.plz_ort ?? null}, iban = ${d.iban},
             bic = ${d.bic ?? null}, bank = ${d.bank ?? null}, steuernr = ${d.steuernr ?? null}, ansprechpartner = ${d.ansprechpartner ?? null},
             email = ${d.email ?? null}, zahlungsziel_tage = ${d.zahlungsziel_tage}, logo = ${d.logo || null},
             paperless_url = ${d.paperless_url || null}, paperless_token = ${d.paperless_token || null},
             n8n_mail_url = ${d.n8n_mail_url || null}, n8n_mail_key = ${d.n8n_mail_key || null},
             n8n_ep3_url = ${d.n8n_ep3_url || null}, n8n_ep3_auth = ${d.n8n_ep3_auth || null},
             halle_stichtag = ${d.halle_stichtag}, halle_ausschluss = ${d.halle_ausschluss},
             fi_bankkonten = ${d.fi_bankkonten}, fi_manuell_konten = ${d.fi_manuell_konten}, fi_beleg_typen = ${d.fi_beleg_typen},
             fi_beleg_pfad = ${d.fi_beleg_pfad}, fi_feld_beleg = ${d.fi_feld_beleg}, fi_feld_betrag = ${d.fi_feld_betrag},
             fi_feld_sap = ${d.fi_feld_sap}, updated_at = now()
       where id = 1`);
    return { ok: true };
  });

  /** Vereinslogo (weiß, für das orange Kopfband) */
  app.get('/logo', { preHandler: requireAuth() }, async (_req, reply) =>
    reply.type('image/png').header('cache-control', 'max-age=86400').send(asset('logo_weiss.png')));

  /** Verbindungstest Paperless */
  app.post('/verein/paperless-test', { preHandler: requireAuth(P.stammdaten) }, async () => {
    const v = await vereinLesen();
    if (!plAktiv(v)) return { ok: false, text: 'Paperless ist nicht eingerichtet (URL und Token).' };
    try {
      const pl = paperless(v);
      const url = await pl.baseUrl();
      const k = await pl.korrespondenten();
      return { ok: true, text: `Verbunden mit ${url} (${k.length} Korrespondenten)` };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  });

  // ---------------------------------------------------------------- Übernahme aus SAP
  const importSchema = z.object({
    dateien: z.array(z.object({ name: z.string(), data: z.string() })).min(1),
    modus: z.enum(['neu', 'aktualisieren']).default('neu'),
  });
  const dekodiert = (d: { name: string; data: string }[]) =>
    d.map((x) => ({ name: x.name, inhalt: Buffer.from(x.data.replace(/^data:[^,]*,/, ''), 'base64') }));

  app.get('/import/tabellen', { preHandler: requireAuth(P.import) }, async () => {
    const out: { tabelle: string; saetze: number }[] = [];
    for (const t of TABELLEN) {
      const [{ n }] = await DB.unsafe(`select count(*)::int as n from tco.${t}`);
      out.push({ tabelle: t, saetze: n });
    }
    return out;
  });

  app.post('/import/pruefen', { preHandler: requireAuth(P.import), bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    const d = importSchema.parse(req.body);
    return pruefen(DB, dekodiert(d.dateien));
  });

  app.post('/import/ausfuehren', { preHandler: requireAuth(P.import), bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    const d = importSchema.parse(req.body);
    return change(req, (tx) => ausfuehren(tx, dekodiert(d.dateien), d.modus), {
      action: 'SAP_IMPORT', reason: d.dateien.map((x) => x.name).join(', '),
    });
  });

  await halleRoutes(app);
  await fiRoutes(app);
}

const tco: ServerModule = {
  id: 'tco',
  name: 'TC Oberthal',
  permissions: [
    { id: P_HALLE.display, text: 'Hallenabrechnung anzeigen' },
    { id: P_HALLE.edit, text: 'Hallenabrechnung: Buchungen zuordnen, Rechnungen bearbeiten, EP3 importieren' },
    { id: P_HALLE.versand, text: 'Hallenrechnungen drucken und versenden (Paperless, E-Mail, WhatsApp)' },
    { id: P_HALLE.preise, text: 'Hallenpreise pflegen' },
    { id: P_FI.display, text: 'FI Belege anzeigen, Notizen erfassen' },
    { id: P_FI.buchen, text: 'FI: Bankimport und manuelle Buchungen, Belege und Rechnungen zuordnen' },
    { id: P_FI.storno, text: 'FI-Belege stornieren' },
    { id: P.stammdaten, text: 'Vereinsdaten und Anbindungen pflegen' },
    { id: P.import, text: 'Übernahme der SAP-Tabellen (CSV)' },
  ],
  auditObjects: [
    { type: 'RECHNUNG', text: 'Hallenrechnung', permission: P_HALLE.display },
    { type: 'BUCHUNG', text: 'Hallenbuchung', permission: P_HALLE.display },
    { type: 'HALLENPREIS', text: 'Hallenpreis', permission: P_HALLE.display },
    { type: 'KOMMPREF', text: 'Bevorzugter Versandweg', permission: P_HALLE.display },
    { type: 'SCHLUESSEL', text: 'Hallenschlüssel', permission: P_HALLE.display },
    { type: 'FIBELEG', text: 'FI-Beleg', permission: P_FI.display },
    { type: 'FIKONTO', text: 'FI-Konto', permission: P_FI.display },
    { type: 'TCO_VEREIN', text: 'Vereinsdaten', permission: P.stammdaten },
    { type: 'MITGLIED', text: 'Mitglied', permission: P_HALLE.display },
  ],
  migrationsDir: path.join(APP_ROOT, 'modules', 'tco', 'server', 'migrations'),
  routes,
};

export default tco;
