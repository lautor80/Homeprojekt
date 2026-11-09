import { mailWiederholen, nichtWiederholbar, WIEDERHOLBAR } from './mailwiederholen.js';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { asset, DB, paperless, plAktiv, vereinLesen, type Verein } from './verein.js';
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
import { meineZeitenRoutes, P_JTM } from './jt/meine.js';
import { platzRoutes, P_MEINKONTO, P_PLATZ, P_REG } from './platz/routes.js';
import { antragRoutes, P_ANTRAG } from './antrag/routes.js';
import { rolleSicherstellen } from './platz/registrierung.js';
import { TCO_KONTEXTE } from './paperless-kontexte.js';
import { P_VZ, verzehrRoutes } from './verzehr/routes.js';
import { kalenderRoutes, P_KAL } from './kalender/routes.js';
import { mailSenden, N8N_PLATZHALTER, N8N_PLATZHALTER_TEXT } from './kommunikation.js';
import { P_PROD, produkteRoutes } from './produkte/routes.js';

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
  n8n_mail_url: z.string().nullish(),
  n8n_mail_key: z.string().nullish().refine((k) => !N8N_PLATZHALTER.test(k?.trim() ?? ''), N8N_PLATZHALTER_TEXT),
  mail_absender: z.preprocess((l) => (Array.isArray(l) ? l.filter((x) => x && (String(x.email ?? '').trim() || String(x.anwendung ?? '').trim())) : l), z.array(z.object({
    anwendung: z.string().trim().min(1, 'Absender: bitte die Anwendung angeben (* = Standard)').max(40),
    email: z.string().trim().email('Absender: ungültige E-Mail-Adresse'),
    name: z.string().trim().max(80).nullish(),
    antwort_an: z.string().trim().email('Absender: ungültige Antwortadresse').or(z.literal('')).nullish(),
  })).max(30)).optional(),
  n8n_ep3_url: z.string().nullish(), n8n_ep3_auth: z.string().nullish(),
  n8n_stunden_url: z.string().nullish(), n8n_ferien_url: z.string().nullish(), n8n_stunden_auth: z.string().nullish(),
  /** Basic Auth für die Webhooks: Benutzer sichtbar, Passwort nur schreibend (MASKE = unverändert) */
  n8n_stunden_user: z.string().nullish(), n8n_stunden_pw: z.string().nullish().refine((k) => !N8N_PLATZHALTER.test(k?.trim() ?? ''), N8N_PLATZHALTER_TEXT),
  n8n_ep3_user: z.string().nullish(), n8n_ep3_pw: z.string().nullish().refine((k) => !N8N_PLATZHALTER.test(k?.trim() ?? ''), N8N_PLATZHALTER_TEXT),
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
             n8n_mail_url = ${d.n8n_mail_url || null}, n8n_mail_key = ${d.n8n_mail_key?.trim() || null},
             mail_absender = ${tx.json((d.mail_absender ?? alt.mail_absender ?? []) as never)},
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
  /** Mailprotokoll (letzte Versuche) und Testmail über den n8n-Workflow */
  app.get('/verein/mailprotokoll', { preHandler: requireAuth(P.stammdaten) }, async () => {
    const rows = await DB`
      select id, to_char(zeit at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI:SS') as zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer,
             nachricht, to_char(erneut_am at time zone 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') as erneut_am, erneut_von, erneut_status
        from tco.mail_protokoll order by id desc limit 50`;
    // Inhalt nie ausliefern – nur, ob und warum (nicht) erneut gesendet werden kann
    return rows.map(({ nachricht, ...p }) => {
      const fehlgeschlagen = WIEDERHOLBAR.includes(p.status) && p.erneut_status !== 'gesendet' && p.erneut_status !== 'entwurf';
      const hinweis = fehlgeschlagen ? nichtWiederholbar({ status: p.status, nachricht, erneut_status: p.erneut_status }) : null;
      const w = (nachricht as { wiederholung?: { art: string } } | null)?.wiederholung?.art;
      return { ...p, erneut: fehlgeschlagen && !hinweis, erneut_hinweis: hinweis,
        erneut_neuer_link: w === 'REG_BESTAETIGUNG' || w === 'EINLADUNG' };
    });
  });
  /** fehlgeschlagene E-Mail erneut senden (Zugangslinks werden dabei neu erzeugt) */
  app.post('/verein/mailprotokoll/:id/erneut', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const v = await vereinLesen();
    return change(req, (tx) => mailWiederholen(tx, v, id, req.user!.displayName || req.user!.username), { action: 'MAIL_ERNEUT', reason: `Mailprotokoll ${id}` });
  });
  app.post('/verein/testmail', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const { an } = z.object({ an: z.string().trim().email('Bitte eine gültige E-Mail-Adresse angeben.') }).parse(req.body);
    const v = await vereinLesen();
    const r = await mailSenden(v, {
      modus: 'senden', anwendung: 'Test', objekt: 'TESTMAIL', an, benutzer: req.user!.displayName || req.user!.username, anhaenge: [],
      betreff: `${v.name}: Testmail aus dem Vereinsportal`,
      text: `Diese Testmail wurde von ${req.user!.displayName || req.user!.username} im Vereinsportal ausgelöst (Stammdaten → Anbindungen).\n\nWenn sie ankommt, funktioniert der Versand über n8n.`,
    });
    if (r.status === 'fehler') throw new BusinessError(`n8n meldet einen Fehler: ${r.fehler ?? 'unbekannt'}`);
    return { text: `Testmail an ${an} übergeben (${r.status}${r.von ? `, Absender ${r.von}` : ''}${r.hinweis ? ` – ${r.hinweis}` : ''}).` };
  });

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
  await platzRoutes(app);
  await fiRoutes(app);
  await sollRoutes(app);
  await jtRoutes(app);
  await meineZeitenRoutes(app);
  await clubhausRoutes(app);
  await verzehrRoutes(app);
  await kalenderRoutes(app);
  await mitgliederRoutes(app);
  await kontenRoutes(app);
  await produkteRoutes(app);
  await antragRoutes(app);
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
    { area: 'Einstellungen', app: 'Produkte', id: P_PROD.display, text: 'Produkte anzeigen (Halle, Getränke, Speisen, Sonstiges – Preise je Zeitraum, Gästepreis, Erlöskonto)' },
    { area: 'Einstellungen', app: 'Produkte', id: P_PROD.edit, text: 'Produkte pflegen: anlegen, Bezeichnung/Preise/Erlöskonto ändern, neuer Preis ab Stichtag, Produkt beenden', requires: [P_PROD.display] },
    { area: 'Einstellungen', app: 'Kontenstamm', id: P_KONTEN.edit, text: 'Konten anlegen und ändern, Kontenverwendung je Jahr, Anfangsbestände der Geldkonten' },
    // ---------------------------------------------------------------- Mitglieder
    { area: 'Mitglieder', app: 'Meine Mitgliedschaft', id: 'tco.meinedaten:edit', text: 'Eigene Mitgliedsdaten sehen, Kontaktdaten und Bankverbindung ändern, Mitgliedschaft/Verträge kündigen (nur das dem Benutzer zugeordnete Mitglied)' },
    { area: 'Mitglieder', app: 'Registrierungen', id: P_REG, text: 'Registrierungen von Mitgliedern prüfen (Abgleich Geburtsdatum/Mitgliedsnummer), freigeben (Rolle Mitglied) oder ablehnen – Aufgabe des Kassenwarts' },
    { area: 'Mitglieder', app: 'Mitgliedsanträge', id: P_ANTRAG.display, text: 'Online-Mitgliedsanträge ansehen (Bankdaten nur mit der Bankdaten-Berechtigung im Klartext)' },
    { area: 'Mitglieder', app: 'Mitgliedsanträge', id: P_ANTRAG.edit, text: 'Online-Mitgliedsanträge prüfen, ablehnen und übernehmen (legt Mitglieder, Verträge, SEPA-Mandat und Benutzer an)', requires: [P_ANTRAG.display, 'tco.mitglieder:edit'] },
    { area: 'Mitglieder', app: 'Vereinskalender', id: P_KAL.anmelden, text: 'Vereinskalender anzeigen und sich selbst zu Veranstaltungen an- bzw. abmelden (nur das dem Benutzer zugeordnete Mitglied)' },
    { area: 'Mitglieder', app: 'Vereinskalender', id: P_KAL.edit, text: 'Veranstaltungen anlegen, ändern, absagen und löschen, Teilnehmerlisten (CSV), Rückmeldungen für Mitglieder setzen, Gruppen/Mannschaften pflegen' },
    { area: 'Mitglieder', app: 'Mitglieder', id: P_MG.display, text: 'Mitglieder anzeigen (Stammdaten, Verträge, SEPA, Dokumente)' },
    { area: 'Mitglieder', app: 'Mitglieder', id: P_MG.edit, text: 'Mitglieder pflegen: Neuanlage, Stammdaten, Verträge, Austritt, Unterlagen ablegen und versenden (Bankverbindung ändern: siehe Datenschutz)' },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.display, text: 'Mitgliedsbeiträge (Beitragsstamm) anzeigen' },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.edit, text: 'Mitgliedsbeiträge pflegen: Beitragsarten, Beträge je Zeitraum, aktiv/inaktiv, Erstbefüllung aus Verträgen' },
    { area: 'Mitglieder', app: 'Mitglieder-Analyse', id: P_AN.display, text: 'Mitglieder-Analyse anzeigen (Auswertungen, Diagramme, CSV, Anzeigevarianten)' },
    // ---------------------------------------------------------------- Jugend
    { area: 'Jugend', app: 'Teilnehmer Jugendtraining', id: P_TN.display, text: 'Teilnehmer Jugendtraining anzeigen' },
    { area: 'Jugend', app: 'Meine Trainingszeiten', id: P_JTM.edit,
      text: 'Eigene Trainingszeiten zurückmelden und eigene Zeitnachweise ansehen – nur für den Trainer, dem der eigene Benutzer zugeordnet ist' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.display, text: 'Abrechnung Jugendtraining anzeigen' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.edit, text: 'Zeiten erfassen und importieren, Zeitnachweise ablegen, als bezahlt kennzeichnen' },
    { area: 'Jugend', app: 'Abrechnung Jugendtraining', id: P_JT.entgelte, text: 'Trainer und Trainerentgelte pflegen' },
    // ---------------------------------------------------------------- Tennishalle
    { area: 'Tennishalle', app: 'Hallenpreise', id: P_HALLE.preise, text: 'Hallenpreise pflegen', requires: [P_HALLE.display] },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.display, text: 'Hallenabrechnung anzeigen' },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.edit, text: 'Buchungen zuordnen, Rechnungen bearbeiten, EP3 importieren' },
    { area: 'Tennishalle', app: 'Hallenabrechnung', id: P_HALLE.versand, text: 'Hallenrechnungen drucken und versenden (Paperless, E-Mail, WhatsApp)' },
    { area: 'Tennishalle', app: 'Meine Daten', id: P_MEINKONTO, text: 'Eigene Kontaktdaten als externer Hallennutzer ansehen und ändern (Anrede, Name, Anschrift, E-Mail, Telefon – nur der dem Benutzer zugeordnete Kundenstammsatz)' },
    { area: 'Tennishalle', app: 'Platz buchen', id: P_PLATZ.buchen,
      text: 'Freiplätze und Halle buchen: eigene Buchungen mit Preisen anzeigen, anlegen, ändern und stornieren – fremde Buchungen nur als „belegt“' },
    { area: 'Tennishalle', app: 'Serienbuchung', id: P_PLATZ.serie,
      text: 'Hallenwart: mehrere Plätze über mehrere Stunden buchen, einmalig oder als Abo (wöchentlich, zweiwöchentlich, monatlich) – mit Verfügbarkeit und Platzvorschlägen' },
    { area: 'Tennishalle', app: 'Platzverwaltung', id: P_PLATZ.admin,
      text: 'Plätze, Gültigkeit, Buchungsdauern, Vorlauf und Stornofristen pflegen; Belegung mit Namen sehen; Abos anlegen; Benutzer den Mitgliedern zuordnen' },
    // ---------------------------------------------------------------- Clubhaus
    { area: 'Clubhaus', app: 'Clubhausabrechnung', id: P_CH.display, text: 'Clubhausabrechnung anzeigen' },
    { area: 'Clubhaus', app: 'Clubhausabrechnung', id: P_CH.edit, text: 'Getränkerechnungen erfassen, Belege zuordnen, Forderungsliste berechnen und ablegen, Getränkepreise pflegen' },
    { area: 'Clubhaus', app: 'Mein Verzehr', id: P_VZ.edit, text: 'Eigenen Verzehr auf das eigene Mitgliedskonto anschreiben, eigene Positionen und Abrechnungen sehen, eigene Einträge in der Frist stornieren (nur das dem Benutzer zugeordnete Mitglied)' },
    { area: 'Clubhaus', app: 'Theke', id: P_VZ.theke, text: 'Thekendienst: Gastbelege erfassen und kassieren, Verzehr für Mitglieder anschreiben, Belege drucken und per E-Mail/WhatsApp senden, heutige Positionen stornieren' },
    { area: 'Clubhaus', app: 'Verzehrbuch', id: P_VZ.display, text: 'Verzehrbuch anzeigen: alle Positionen, Belege, Kennzahlen, Monatsabschluss-Vorschau' },
    { area: 'Clubhaus', app: 'Verzehrbuch', id: P_VZ.admin, text: 'Verzehr verwalten: Preisliste Speisen/Sonstiges und Gästepreise, Stornos, Monatsabschluss (Sammelabrechnungen), Belege bezahlen/stornieren, Einstellungen', requires: [P_VZ.display] },
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
  paperlessKontexte: TCO_KONTEXTE,
  mailer: async (m) => {
    const v = await vereinLesen();
    const r = await mailSenden(v, { modus: 'senden', anwendung: m.anwendung, objekt: m.objekt, an: m.an, betreff: m.betreff, text: m.text, benutzer: 'Portal', anhaenge: [],
      // enthält einen persönlichen Kennwort-Link: nie speichern, sondern neu auslösen
      wiederholung: { art: 'NEU_AUSLOESEN', hinweis: 'Enthält einen persönlichen Kennwort-Link – bitte neu auslösen: Administration → Benutzer → „Kennwort-Link senden“ bzw. „Passwort vergessen“ auf der Anmeldeseite.' } });
    if (r.status === 'fehler') throw new Error(r.fehler ?? 'Der Versand ist fehlgeschlagen.');
  },
  paperlessClient: async () => { const v = await vereinLesen(); return plAktiv(v) ? paperless(v) : null; },
  // Systemrollen „Mitglied“/„Hallennutzer“ nach einer Rücksicherung (ältere Sicherung) wieder herstellen
  nachRuecksicherung: async () => { await rolleSicherstellen(DB); },
  // „Meine Mitgliedschaft“: das eigene Mitglied darf gesperrt werden (gegen gleichzeitige Pflege durch den Vorstand)
  sperreErlaubt: async (req, objekt, schluessel) => {
    if (objekt !== 'MITGLIED' || !req.user?.id || !req.user.permissions.has('tco.meinedaten:edit')) return false;
    const [a] = await DB`select adrnr from tco.mitgliedera where benutzer_id = ${req.user.id}`;
    return a?.adrnr === schluessel;
  },
  // ausgewählte, noch nicht gesicherte Platzzeit (Sperre mit Zeitraum, Schlüssel = Platz-ID)
  sperrObjekte: [{ type: 'PLATZZEIT', text: 'Platzzeit', permission: `${P_PLATZ.buchen}|${P_PLATZ.admin}|${P_PLATZ.serie}` }],
  registrierung: { pfad: '/api/m/tco/platz/registrierung', titel: 'Zum Vereinsportal registrieren', text: 'Zugang für Mitglieder und Hallennutzer – Mitglieder nach Prüfung durch den Verein, Hallennutzer nach Bestätigung der E-Mail-Adresse.' },
  auditObjects: [
    { type: 'REGISTRIERUNG', text: 'Registrierung Hallennutzer', permission: P_PLATZ.admin },
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
    { type: 'VZ_POSTEN', text: 'Verzehrposition Clubhaus', permission: P_VZ.display },
    { type: 'VZ_BELEG', text: 'Verzehrbeleg / Sammelabrechnung Clubhaus', permission: P_VZ.display },
    { type: 'VZ_CFG', text: 'Einstellungen Verzehr', permission: P_VZ.display },
    { type: 'TCO_VEREIN', text: 'Vereinsdaten', permission: P.stammdaten },
    { type: 'PLATZ', text: 'Platz', permission: P_PLATZ.admin },
    { type: 'PLATZBELEGUNG', text: 'Feste Platzbelegung (Training, Sperrzeit)', permission: P_PLATZ.admin },
    { type: 'KAL_EVENT', text: 'Veranstaltung (Vereinskalender)', permission: P_KAL.edit },
    { type: 'KAL_ANMELDUNG', text: 'An-/Abmeldung Veranstaltung', permission: P_KAL.edit },
    { type: 'KAL_GRUPPE', text: 'Gruppe/Mannschaft (Vereinskalender)', permission: P_KAL.edit },
    { type: 'MITGLIED', text: 'Mitglied', permission: P_MG.display, sperrtAuch: ['SCHLUESSEL', 'KOMMPREF'] },
  ],
  migrationsDir: path.join(APP_ROOT, 'modules', 'tco', 'server', 'migrations'),
  routes,
};

export default tco;
