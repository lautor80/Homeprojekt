import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ServerModule } from '../../../server/src/module.js';
import { APP_ROOT } from '../../../server/src/config.js';
import { change, requireAuth } from '../../../server/src/auth.js';
import { asset, DB, vereinLesen, type Db, type Verein } from './verein.js';
import { ausfuehren, pruefen, TABELLEN } from './importer.js';
import { entpacken, istZip } from '../../../server/src/lib/zip.js';
import { BusinessError } from '../../../server/src/errors.js';
import { halleRoutes, P_HALLE } from './halle/routes.js';
import { fiRoutes, P_FI } from './fi/routes.js';
import { P_SOLL, sollRoutes } from './soll/routes.js';
import { jtRoutes, P_JT } from './jt/routes.js';
import { TCO_VERBINDUNGEN } from './verbindung.js';
import { clubhausRoutes, P_CH } from './clubhaus/routes.js';
import { mitgliederRoutes, P_MG } from './mitglieder/routes.js';
import { gruppenRoutes, P_GR } from './gruppen/routes.js';
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
import { P_SCHNUPPER, schnupperRoutes } from './schnupper/routes.js';
import { rolleSicherstellen } from './platz/registrierung.js';
import { ichLesen, QUELLE } from './platz/logik.js';
import { TCO_KONTEXTE } from './paperless-kontexte.js';
import { P_VZ, verzehrRoutes } from './verzehr/routes.js';
import { kalenderRoutes, P_KAL } from './kalender/routes.js';
import { mailFolge, mailWiederholen } from './mailwiederholen.js';
import { mailPersonen } from './mailpersonen.js';
import { P_PROD, produkteRoutes } from './produkte/routes.js';
import { eingangRoutes, P_EING } from './eingang/routes.js';

const P = {
  stammdaten: 'tco.stammdaten:edit',
  import: 'tco.import:execute',
};

const MASKE = '********';

const vereinSchema = z.object({
  name: z.string().trim().min(1, 'Bitte den Vereinsnamen angeben').max(70),
  strasse: z.string().nullish(), plz_ort: z.string().nullish(),
  iban: z.string().nullish().transform((v) => v?.replace(/\s/g, '').toUpperCase() || null),
  bic: z.string().nullish(), bank: z.string().nullish(), steuernr: z.string().nullish(),
  ansprechpartner: z.string().nullish(), email: z.string().nullish(),
  zahlungsziel_tage: z.coerce.number().int().min(0).max(90),
  logo: z.string().nullish(),
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

async function routes(app: FastifyInstance) {
  app.get('/verein', { preHandler: requireAuth(P.stammdaten) }, async () => {
    const v = await vereinLesen();
    const out: Record<string, unknown> = { ...v };
    // Anbindungen werden zentral gepflegt (Administration → Anbindungen); hier nur der Stand, Geheimnisse maskiert
    for (const g of ['paperless_token', 'n8n_mail_key', 'n8n_ep3_auth', 'n8n_stunden_auth', 'n8n_ferien_auth'] as const) out[g] = v[g] ? MASKE : '';
    return out;
  });

  app.put('/verein', { preHandler: requireAuth(P.stammdaten) }, async (req) => {
    const d = vereinSchema.parse(req.body);
    const alt = await vereinLesen();
    const FI = ['fi_bankkonten', 'fi_manuell_konten', 'fi_beleg_typen', 'fi_beleg_pfad', 'fi_feld_beleg', 'fi_feld_betrag', 'fi_feld_sap'] as const;
    for (const k of FI) if (d[k] === undefined) d[k] = alt[k];
    await change(req, (tx) => tx`
      update tco.verein set name = ${d.name}, strasse = ${d.strasse ?? null}, plz_ort = ${d.plz_ort ?? null}, iban = ${d.iban},
             bic = ${d.bic ?? null}, bank = ${d.bank ?? null}, steuernr = ${d.steuernr ?? null}, ansprechpartner = ${d.ansprechpartner ?? null},
             email = ${d.email ?? null}, zahlungsziel_tage = ${d.zahlungsziel_tage}, logo = ${d.logo || null},
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
  await gruppenRoutes(app);
  await kontenRoutes(app);
  await produkteRoutes(app);
  await antragRoutes(app);
  await schnupperRoutes(app);
  await finanzRoutes(app);
  await beitraegeRoutes(app);
  await forecastRoutes(app);
  await abschlussRoutes(app);
  await dashboardRoutes(app);
  await analyseRoutes(app);
  await teilnehmerRoutes(app);
  await uploadRoutes(app);
  await eingangRoutes(app);
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
    { area: 'Mitglieder', app: 'Mitglieder', id: P_MG.edit, text: 'Mitglieder pflegen: Neuanlage, Stammdaten, Verträge, Austritt, Gruppen zuordnen, Unterlagen ablegen und versenden (Bankverbindung ändern: siehe Datenschutz)' },
    { area: 'Mitglieder', app: 'Mitgliedergruppen', id: P_GR.display, text: 'Mitgliedergruppen anzeigen: Baum der Kategorien, Gruppen und Mannschaften mit den zugeordneten Mitgliedern' },
    { area: 'Mitglieder', app: 'Mitgliedergruppen', id: P_GR.edit, text: 'Mitgliedergruppen pflegen: Gruppen anlegen, ändern, verschieben und löschen, Mitglieder zuordnen und Rollen vergeben', requires: [P_GR.display] },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.display, text: 'Mitgliedsbeiträge (Beitragsstamm) anzeigen' },
    { area: 'Mitglieder', app: 'Mitgliedsbeiträge', id: P_BEITRAEGE.edit, text: 'Mitgliedsbeiträge pflegen: Beitragsarten, Beträge je Zeitraum, aktiv/inaktiv, Erstbefüllung aus Verträgen' },
    { area: 'Mitglieder', app: 'Mitglieder-Analyse', id: P_AN.display, text: 'Mitglieder-Analyse anzeigen (Auswertungen, Diagramme, CSV, Anzeigevarianten)' },
    // ---------------------------------------------------------------- Jugend
    { area: 'Jugend', app: 'Teilnehmer Jugendtraining', id: P_TN.display, text: 'Teilnehmer Jugendtraining anzeigen' },
    { area: 'Jugend', app: 'Schnuppertraining', id: P_SCHNUPPER.display, text: 'Anmeldungen zum Schnuppertraining ansehen (Name, Alter, Spielstärke, Kontakt, Wunschtermine) – ohne Zugriff auf den übrigen Mitgliederstamm' },
    { area: 'Jugend', app: 'Schnuppertraining', id: P_SCHNUPPER.edit, text: 'Schnuppertraining betreuen: Status, Termine der Einheiten, Trainer und Notiz pflegen, Beitrittslink (vorbelegter Mitgliedsantrag) senden', requires: [P_SCHNUPPER.display] },
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
    // ---------------------------------------------------------------- Dokumente
    { area: 'Dokumente', app: 'Dokumenteneingang', id: P_EING.display, text: 'Dokumenteneingang anzeigen: Regelwerk, Korrespondenten und Protokoll der eingegangenen E-Mails mit Ablageort (ohne Inhalte)' },
    { area: 'Dokumente', app: 'Dokumenteneingang', id: P_EING.edit, text: 'Regelwerk und Korrespondenten des Dokumenteneingangs pflegen, Prüfliste bearbeiten: Mailtext und Anhänge offener Vorgänge ansehen, ablegen oder ignorieren', requires: [P_EING.display] },
    { area: 'Dokumente', app: 'Dokumenteneingang', id: P_EING.melden, text: 'Schnittstelle für n8n (API-Schlüssel): eingegangene E-Mails samt Anhängen an das Portal liefern und deren Behandlung abholen' },
    // ---------------------------------------------------------------- Datenschutz (Feldberechtigungen)
    { area: 'Datenschutz', app: 'Bankdaten von Personen', id: P_BANK.display,
      text: 'IBAN, BIC und abweichenden Kontoinhaber im Klartext sehen (sonst maskiert) – auch in Unterlagen, Änderungsbelegen und der SEPA-Datei' },
    { area: 'Datenschutz', app: 'Bankdaten von Personen', id: P_BANK.edit,
      text: 'Bankverbindung von Mitgliedern und Zahlern ändern', requires: [P_MG.edit] },
  ],
  sensitiveFields: BANK_FELDER,
  paperlessKontexte: TCO_KONTEXTE,
  verbindungen: TCO_VERBINDUNGEN,
  mailWiederholen, mailFolge, mailPersonen,
  // Systemrollen „Mitglied“/„Hallennutzer“ nach einer Rücksicherung (ältere Sicherung) wieder herstellen
  nachRuecksicherung: async () => { await rolleSicherstellen(DB); },
  // Benutzer nur löschbar, solange er nichts gebucht hat: Platzbuchungen (eigene Portalbuchungen und – wie in
  // „Meine Buchungen“ – die EP3-Buchungen des zugeordneten Mitglieds/Kunden, auch stornierte) und Verzehr
  benutzerLoeschenSperre: async (tx, benutzerId) => {
    const ich = await ichLesen(tx, benutzerId);
    const [p] = await tx`
      select count(distinct bid)::int as n from tco.bookings
       where benutzer_id = ${benutzerId}
          or (${ich?.kunde ?? null}::text is not null and quelle is distinct from ${QUELLE} and upper(trim(kunde)) = ${ich?.kunde ?? null}::text)`;
    const [v] = await tx`select count(*)::int as n from tco.vz_posten where erfasst_benutzer = ${benutzerId}`;
    const g: string[] = [];
    if (p.n) g.push(`${p.n} Platzbuchung${p.n === 1 ? '' : 'en'} vorhanden`);
    if (v.n) g.push(`${v.n} Verzehrposition${v.n === 1 ? '' : 'en'} erfasst`);
    return g.length ? g.join(', ') : null;
  },
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
    { type: 'KAL_GRUPPE', text: 'Mitgliedergruppe / Mannschaft', permission: P_KAL.edit },
    { type: 'MITGLIED', text: 'Mitglied', permission: P_MG.display, sperrtAuch: ['SCHLUESSEL', 'KOMMPREF'] },
    { type: 'EING_REGEL', text: 'Regel Dokumenteneingang', permission: P_EING.display },
    { type: 'EING_KORRESPONDENT', text: 'Korrespondent Dokumenteneingang', permission: P_EING.display },
  ],
  migrationsDir: path.join(APP_ROOT, 'modules', 'tco', 'server', 'migrations'),
  routes,
};

export default tco;
