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
import { kontenRoutes, P_KONTEN } from './konten/routes.js';
import { finanzRoutes, P_FINANZ } from './finanz/routes.js';
import { beitraegeRoutes, P_BEITRAEGE } from './beitraege/routes.js';
import { forecastRoutes, P_FORECAST } from './forecast/routes.js';
import { abschlussRoutes, P_ABSCHLUSS } from './abschluss/routes.js';
import { dashboardRoutes, P_DASH } from './dashboard/routes.js';
import { analyseRoutes, P_AN } from './analyse/routes.js';
import { P_TN, teilnehmerRoutes } from './teilnehmer/routes.js';
import { P_UP, uploadRoutes } from './upload/routes.js';
import { BANK_FELDER, P_BANK } from './bankdaten.js';

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
  mg_ansprechpartner: z.string().optional(),
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
  app.get('/verein', { preHandler: requireAuth(P.stammdaten) }, async () => {
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
             fi_feld_sap = ${d.fi_feld_sap}, mg_ansprechpartner = ${d.mg_ansprechpartner ?? alt.mg_ansprechpartner ?? ''}, updated_at = now()
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
  await kontenRoutes(app);
  await finanzRoutes(app);
  await beitraegeRoutes(app);
  await forecastRoutes(app);
  await abschlussRoutes(app);
  await dashboardRoutes(app);
  await analyseRoutes(app);
  await teilnehmerRoutes(app);
  await uploadRoutes(app);
}

const tco: ServerModule = {
  id: 'tco',
  name: 'TC Oberthal',
  // Reihenfolge und Gliederung wie die Navigation (modules/tco/web/index.ts): Bereich (Stufe 2) → App (Stufe 3) → Aktivität
  permissions: [
    // ---------------------------------------------------------------- Vereinsübersicht
    { area: 'Vereinsübersicht', app: 'Vereinsübersicht', id: P_DASH.display, text: 'Vereinsübersicht (Dashboard) anzeigen' },
    { area: 'Vereinsübersicht', app: 'Vereinsübersicht', id: P_DASH.edit, text: 'Beitragsstufenwechsel Jugendliche → Erwachsene ausführen' },
    // ---------------------------------------------------------------- Einstellungen
    { area: 'Einstellungen', app: 'Stammdaten', id: P.stammdaten, text: 'Vereinsdaten und Anbindungen pflegen' },
    { area: 'Einstellungen', app: 'Stammdaten', id: P.import, text: 'Übernahme der SAP-Tabellen (CSV)', requires: [P.stammdaten] },
    { area: 'Einstellungen', app: 'Kontenstamm', id: P_KONTEN.display, text: 'Kontenstamm anzeigen (Konten, Kontenverwendung, Anfangsbestände)' },
    { area: 'Einstellungen', app: 'Kontenstamm', id: P_KONTEN.edit, text: 'Konten anlegen und ändern, Kontenverwendung je Jahr, Anfangsbestände der Geldkonten' },
    // ---------------------------------------------------------------- Mitglieder
    { area: 'Mitglieder', app: 'Mitglieder', id: P_MG.display, text: 'Mitglieder anzeigen (Stammdaten, Verträge, SEPA, Dokumente)' },
    { area: 'Mitglieder', app: 'Mitglieder', id: P_MG.edit, text: 'Mitglieder pflegen: Neuanlage, Stammdaten, Verträge, Austritt, Unterlagen ablegen und versenden (Bankverbindung ändern: siehe Datenschutz)' },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.display, text: 'Mitgliedsbeiträge (Beitragsstamm) anzeigen' },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.edit, text: 'Mitgliedsbeiträge pflegen: Beitragsarten, Beträge je Zeitraum, aktiv/inaktiv, Erstbefüllung aus Verträgen' },
    { area: 'Mitglieder', app: 'Mitglieder-Analyse', id: P_AN.display, text: 'Mitglieder-Analyse anzeigen (Auswertungen, Diagramme, CSV, Anzeigevarianten)' },
    // ---------------------------------------------------------------- Jugend
    { area: 'Jugend', app: 'Teilnehmer Jugendtraining', id: P_TN.display, text: 'Teilnehmer Jugendtraining anzeigen' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.display, text: 'Abrechnung Jugendtraining anzeigen' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.edit, text: 'Zeiten erfassen und importieren, Zeitnachweise ablegen, als bezahlt kennzeichnen' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.entgelte, text: 'Trainer und Trainerentgelte pflegen' },
    // ---------------------------------------------------------------- Tennishalle
    { area: 'Tennishalle', app: 'Hallenpreise', id: P_HALLE.preise, text: 'Hallenpreise pflegen', requires: [P_HALLE.display] },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.display, text: 'Hallenabrechnung anzeigen' },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.edit, text: 'Buchungen zuordnen, Rechnungen bearbeiten, EP3 importieren' },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.versand, text: 'Hallenrechnungen drucken und versenden (Paperless, E-Mail, WhatsApp)' },
    // ---------------------------------------------------------------- Clubhaus
    { area: 'Clubhaus', app: 'Clubhausabrechnung', id: P_CH.display, text: 'Clubhausabrechnung anzeigen' },
    { area: 'Clubhaus', app: 'Clubhausabrechnung', id: P_CH.edit, text: 'Getränkerechnungen erfassen, Belege zuordnen, Forderungsliste berechnen und ablegen, Getränkepreise pflegen' },
    // ---------------------------------------------------------------- Finanzen
    { area: 'Finanzen', app: 'Sollstellungen', id: P_SOLL.display, text: 'Sollstellungen anzeigen' },
    { area: 'Finanzen', app: 'Sollstellungen', id: P_SOLL.edit, text: 'Lastschriftlauf erzeugen, herunterladen, stornieren' },
    { area: 'Finanzen', app: 'Sollstellungen', id: P_SOLL.glaeubiger, text: 'Gläubigerdaten (Vereinskonto, Gläubiger-ID) pflegen' },
    { area: 'Finanzen', app: 'FI-Belege', id: P_FI.display, text: 'FI-Belege anzeigen, Notizen erfassen' },
    { area: 'Finanzen', app: 'FI-Belege', id: P_FI.buchen, text: 'Bankimport und manuelle Buchungen, Belege und Rechnungen zuordnen' },
    { area: 'Finanzen', app: 'FI-Belege', id: P_FI.storno, text: 'FI-Belege stornieren' },
    { area: 'Finanzen', app: 'Beitragsforecast', id: P_FORECAST.display, text: 'Beitragsforecast anzeigen' },
    { area: 'Finanzen', app: 'Einnahmen und Ausgaben', id: P_FINANZ.display, text: 'Einnahmen und Ausgaben anzeigen' },
    { area: 'Finanzen', app: 'Jahresabschluss', id: P_ABSCHLUSS.display, text: 'Jahresabschluss anzeigen (EAR, Vermögensübersicht, Anlagenspiegel, PDF)' },
    { area: 'Finanzen', app: 'Jahresabschluss', id: P_ABSCHLUSS.edit, text: 'Anlagevermögen pflegen, Abschluss in Paperless ablegen' },
    { area: 'Finanzen', app: 'Dokumenten-Upload', id: P_UP.execute, text: 'Belege gesammelt nach Paperless übertragen' },
    // ---------------------------------------------------------------- Datenschutz (Feldberechtigungen)
    { area: 'Datenschutz', app: 'Bankdaten von Personen', id: P_BANK.display,
      text: 'IBAN, BIC und abweichenden Kontoinhaber im Klartext sehen (sonst maskiert) – auch in Unterlagen, Änderungsbelegen und der SEPA-Datei' },
    { area: 'Datenschutz', app: 'Bankdaten von Personen', id: P_BANK.edit,
      text: 'Bankverbindung von Mitgliedern und Zahlern ändern', requires: [P_MG.edit] },
  ],
  sensitiveFields: BANK_FELDER,
  auditObjects: [
    { type: 'RECHNUNG', text: 'Hallenrechnung', permission: P_HALLE.display },
    { type: 'BUCHUNG', text: 'Hallenbuchung', permission: P_HALLE.display },
    { type: 'HALLENPREIS', text: 'Hallenpreis', permission: P_HALLE.display },
    { type: 'KOMMPREF', text: 'Bevorzugter Versandweg', permission: P_HALLE.display },
    { type: 'SCHLUESSEL', text: 'Hallenschlüssel', permission: P_HALLE.display },
    { type: 'FIBELEG', text: 'FI-Beleg', permission: P_FI.display },
    { type: 'FIKONTO', text: 'FI-Konto', permission: P_FI.display },
    { type: 'FIBANKAB', text: 'Anfangs-/Endbestand Geldkonto', permission: P_KONTEN.display },
    { type: 'BEITRAG', text: 'Beitragsart', permission: P_BEITRAEGE.display },
    { type: 'ANLAGE', text: 'Anlageobjekt', permission: P_ABSCHLUSS.display },
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
