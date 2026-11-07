import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { asset, DB, vereinLesen, type Verein } from './verein.js';
import { ausfuehren, pruefen, TABELLEN } from './importer.js';
import { entpacken, istZip } from '../../../server/src/lib/zip.js';
import { BusinessError } from '../../../server/src/errors.js';
import { halleRoutes, P_HALLE } from './halle/routes.js';
import { fiRoutes, P_FI } from './fi/routes.js';
import { P_SOLL, sollRoutes } from './soll/routes.js';
import { jtRoutes, P_JT } from './jt/routes.js';
import { ENDPUNKTE, verbindungTesten } from './verbindung.js';
import { clubhausRoutes, P_CH } from './clubhaus/routes.js';
import { mitgliederRoutes, P_MG } from './mitglieder/routes.js';

const P = {
  stammdaten: 'tco.stammdaten:edit',
  import: 'tco.import:execute',
};

const MASKE = '********';
const GEHEIM = ['paperless_token', 'n8n_mail_key', 'n8n_ep3_auth', 'n8n_stunden_auth'] as const;

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
  n8n_stunden_url: z.string().nullish(), n8n_ferien_url: z.string().nullish(), n8n_stunden_auth: z.string().nullish(),
  /** Basic Auth für die Webhooks: Benutzer sichtbar, Passwort nur schreibend (MASKE = unverändert) */
  n8n_stunden_user: z.string().nullish(), n8n_stunden_pw: z.string().nullish(),
  n8n_ep3_user: z.string().nullish(), n8n_ep3_pw: z.string().nullish(),
  halle_stichtag: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  halle_ausschluss: z.string().default(''),
  halle_plaetze: z.string().optional(),
  fi_bankkonten: z.string().optional(),
  fi_manuell_konten: z.string().optional(),
  fi_beleg_typen: z.string().optional(),
  fi_beleg_pfad: z.string().optional(),
  fi_feld_beleg: z.string().trim().min(1).optional(),
  fi_feld_betrag: z.string().trim().min(1).optional(),
  fi_feld_sap: z.string().trim().min(1).optional(),
});

type VereinEingabe = z.infer<typeof vereinSchema>;

/** Basic-Auth-Header aus Benutzer und Passwort (wie SM59 „Basic Authentication“) */
export const basicAuth = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`, 'utf8').toString('base64')}`;

/**
 * Geheime Felder übernehmen: MASKE = bisheriger Wert. Für die Webhooks wird aus Benutzer und Passwort
 * der Authorization-Header gebildet; ohne Benutzer und Passwort entfällt die Anmeldung.
 */
function zugangUebernehmen(d: VereinEingabe, alt: Verein) {
  for (const g of GEHEIM) if (d[g] === MASKE) d[g] = alt[g];
  for (const [k, auth, userAlt] of [['stunden', 'n8n_stunden_auth', alt.n8n_stunden_user], ['ep3', 'n8n_ep3_auth', alt.n8n_ep3_user]] as const) {
    if (d[`n8n_${k}_pw`] === undefined && d[`n8n_${k}_user`] === undefined) { d[auth] = alt[auth]; continue; }
    const user = (d[`n8n_${k}_user`] ?? '').trim();
    const pw = d[`n8n_${k}_pw`] ?? '';
    if (pw === MASKE) {
      // Passwort unverändert: bisherigen Header behalten (auch einen früher direkt eingetragenen)
      if (user && user !== (userAlt ?? '')) throw new BusinessError('Nach dem Ändern des Benutzers bitte das Passwort neu eingeben.');
      d[auth] = alt[auth];
      d[`n8n_${k}_user`] = userAlt ?? null;
      continue;
    }
    if (!user && !pw) { d[auth] = null; d[`n8n_${k}_user`] = null; continue; }
    if (!user || !pw) throw new BusinessError('Für die Anmeldung am Webhook bitte Benutzer und Passwort angeben.');
    d[auth] = basicAuth(user, pw);
    d[`n8n_${k}_user`] = user;
  }
}

async function routes(app: FastifyInstance) {
  app.get('/verein', { preHandler: requireAuth() }, async () => {
    const v = await vereinLesen();
    const out: Record<string, unknown> = { ...v };
    for (const g of GEHEIM) out[g] = v[g] ? MASKE : '';
    out.n8n_stunden_pw = v.n8n_stunden_auth ? MASKE : '';
    out.n8n_ep3_pw = v.n8n_ep3_auth ? MASKE : '';
    return out;
  });

  app.put('/verein', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const d = vereinSchema.parse(req.body);
    const alt = await vereinLesen();
    zugangUebernehmen(d, alt);
    const FI = ['fi_bankkonten', 'fi_manuell_konten', 'fi_beleg_typen', 'fi_beleg_pfad', 'fi_feld_beleg', 'fi_feld_betrag', 'fi_feld_sap'] as const;
    for (const k of FI) if (d[k] === undefined) d[k] = alt[k];
    await change(req, (tx) => tx`
      update tco.verein set name = ${d.name}, strasse = ${d.strasse ?? null}, plz_ort = ${d.plz_ort ?? null}, iban = ${d.iban},
             bic = ${d.bic ?? null}, bank = ${d.bank ?? null}, steuernr = ${d.steuernr ?? null}, ansprechpartner = ${d.ansprechpartner ?? null},
             email = ${d.email ?? null}, zahlungsziel_tage = ${d.zahlungsziel_tage}, logo = ${d.logo || null},
             paperless_url = ${d.paperless_url || null}, paperless_token = ${d.paperless_token || null},
             n8n_mail_url = ${d.n8n_mail_url || null}, n8n_mail_key = ${d.n8n_mail_key || null},
             n8n_ep3_url = ${d.n8n_ep3_url || null}, n8n_ep3_auth = ${d.n8n_ep3_auth || null},
             n8n_stunden_url = ${d.n8n_stunden_url || null}, n8n_ferien_url = ${d.n8n_ferien_url || null}, n8n_stunden_auth = ${d.n8n_stunden_auth || null},
             n8n_stunden_user = ${d.n8n_stunden_user || null}, n8n_ep3_user = ${d.n8n_ep3_user || null},
             halle_stichtag = ${d.halle_stichtag}, halle_ausschluss = ${d.halle_ausschluss}, halle_plaetze = ${d.halle_plaetze ?? alt.halle_plaetze},
             fi_bankkonten = ${d.fi_bankkonten}, fi_manuell_konten = ${d.fi_manuell_konten}, fi_beleg_typen = ${d.fi_beleg_typen},
             fi_beleg_pfad = ${d.fi_beleg_pfad}, fi_feld_beleg = ${d.fi_feld_beleg}, fi_feld_betrag = ${d.fi_feld_betrag},
             fi_feld_sap = ${d.fi_feld_sap}, updated_at = now()
       where id = 1`);
    return { ok: true };
  });

  /** Vereinslogo (weiß, für das orange Kopfband) */
  app.get('/logo', { preHandler: requireAuth() }, async (_req, reply) =>
    reply.type('image/png').header('cache-control', 'max-age=86400').send(asset('logo_weiss.png')));

  /** Verbindungstest Paperless (gespeicherte Werte) */
  app.post('/verein/paperless-test', { preHandler: requireAuth(P.stammdaten) }, async () => verbindungTesten(await vereinLesen(), 'paperless'));

  /** Verbindungstest je Endpunkt mit den Werten aus dem Formular (noch nicht gesichert); MASKE = gespeicherter Wert */
  app.post('/verein/test/:endpunkt', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const { endpunkt } = z.object({ endpunkt: z.enum(ENDPUNKTE) }).parse(req.params);
    const alt = await vereinLesen();
    const d = vereinSchema.partial().parse(req.body ?? {}) as VereinEingabe;
    zugangUebernehmen(d, alt);
    const v = { ...alt } as Verein;
    for (const [k, w] of Object.entries(d)) if (w !== undefined && k in alt) (v as unknown as Record<string, unknown>)[k] = w || null;
    return verbindungTesten(v, endpunkt);
  });

  // ---------------------------------------------------------------- Übernahme aus SAP
  const importSchema = z.object({
    dateien: z.array(z.object({ name: z.string(), data: z.string() })).min(1),
    modus: z.enum(['neu', 'aktualisieren']).default('neu'),
  });
  /** Dateien dekodieren; ZIP-Archive (Report ZTCO_PORTAL_EXPORT) werden entpackt */
  const dekodiert = (d: { name: string; data: string }[]) => d.flatMap((x) => {
    const inhalt = Buffer.from(x.data.replace(/^data:[^,]*,/, ''), 'base64');
    if (!istZip(inhalt)) return [{ name: x.name, inhalt }];
    try {
      return entpacken(inhalt).filter((e) => /\.(csv|txt)$/i.test(e.name));
    } catch (e) {
      throw new BusinessError(`${x.name}: ${(e as Error).message}`);
    }
  });

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
      action: 'SAP_IMPORT', reason: d.dateien.map((x) => x.name).join(', ').slice(0, 500),
    });
  });

  await halleRoutes(app);
  await fiRoutes(app);
  await sollRoutes(app);
  await jtRoutes(app);
  await clubhausRoutes(app);
  await mitgliederRoutes(app);
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
    { id: P_SOLL.display, text: 'Sollstellung anzeigen' },
    { id: P_SOLL.edit, text: 'Sollstellung: Lastschriftlauf erzeugen, herunterladen, stornieren' },
    { id: P_SOLL.glaeubiger, text: 'Sollstellung: Gläubigerdaten (Vereinskonto, Gläubiger-ID) pflegen' },
    { id: P_JT.display, text: 'Abrechnung Jugendtraining anzeigen' },
    { id: P_JT.edit, text: 'Jugendtraining: Zeiten erfassen und importieren, Zeitnachweise ablegen, als bezahlt kennzeichnen' },
    { id: P_JT.entgelte, text: 'Jugendtraining: Trainer und Trainerentgelte pflegen' },
    { id: P_CH.display, text: 'Clubhausabrechnung anzeigen' },
    { id: P_CH.edit, text: 'Clubhaus: Getränkerechnungen erfassen, Belege zuordnen, Forderungsliste berechnen und ablegen, Getränkepreise pflegen' },
    { id: P_MG.display, text: 'Mitglieder anzeigen (Stammdaten, Verträge, SEPA, Dokumente)' },
    { id: P_MG.edit, text: 'Mitglieder pflegen: Neuanlage, Stammdaten, Bank, Verträge, Austritt, Unterlagen ablegen und versenden' },
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
    { type: 'SOLLSTELLUNG', text: 'Sollstellung', permission: P_SOLL.display },
    { type: 'SOLL_CFG', text: 'Gläubigerdaten', permission: P_SOLL.display },
    { type: 'JT_ZEIT', text: 'Trainingszeit Jugendtraining', permission: P_JT.display },
    { type: 'JT_NACHWEIS', text: 'Zeitnachweis Jugendtraining', permission: P_JT.display },
    { type: 'TRAINERENTGELT', text: 'Trainerentgelt', permission: P_JT.display },
    { type: 'GETRAENKERECHNUNG', text: 'Getränkerechnung', permission: P_CH.display },
    { type: 'CLUBHAUS', text: 'Clubhaus-Forderungsliste', permission: P_CH.display },
    { type: 'TCO_VEREIN', text: 'Vereinsdaten', permission: P.stammdaten },
    { type: 'MITGLIED', text: 'Mitglied', permission: P_MG.display },
  ],
  migrationsDir: path.join(APP_ROOT, 'modules', 'tco', 'server', 'migrations'),
  routes,
};

export default tco;
