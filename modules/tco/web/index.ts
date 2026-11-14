import type { WebModule } from '@core/platform';
import { Hallenabrechnung } from './Hallenabrechnung';
import { MailtexteKapitel } from './einstellungen/Mailtexte';
import { Kontenfindung } from './einstellungen/Kontenfindung';
import { ImportTab, VereinFinanzen, VereinFiPaperless, VereinHalle, VereinLogo, VereinTab, ZuVereinEinstellungen } from './Stammdaten';
import { FiBelege } from './fi/FiBelege';
import { GlaeubigerKapitel, Sollstellung } from './soll/Sollstellung';
import { Jugendtraining } from './jt/Jugendtraining';
import { Clubhaus, ClubhausKapitel, ClubhausPaperless } from './clubhaus/Clubhaus';
import { MeinVerzehr } from './verzehr/MeinVerzehr';
import { Theke } from './verzehr/Theke';
import { Verzehrbuch, VerzehrKapitel } from './verzehr/Verzehrbuch';
import { Kalender } from './kalender/Kalender';
import { Mitglieder } from './mitglieder/Mitglieder';
import { Gruppen } from './gruppen/Gruppen';
import { Dashboard, DashboardPage } from './dashboard/Dashboard';
import { Praesentationen } from './praesentation/Praesentationen';
import { Spielerdaten } from './sport/Spielerdaten';
import { Analyse } from './analyse/Analyse';
import { Teilnehmer } from './teilnehmer/Teilnehmer';
import { Upload } from './upload/Upload';
import { Beitraege } from './beitraege/Beitraege';
import { Forecast } from './forecast/Forecast';
import { Finanz } from './finanz/Finanz';
import { Konten } from './konten/Konten';
import { Produkte, ZuHallenpreisen } from './produkte/Produkte';
import { Beitritt } from './antrag/Beitritt';
import { Mitgliedsantraege } from './antrag/Mitgliedsantraege';
import { Schnuppertraining } from './schnupper/Schnuppertraining';
import { SchnupperVerwaltung } from './schnupper/SchnupperVerwaltung';
import { RegistrierungBestaetigen } from './platz/RegistrierungBestaetigen';
import { ZugaengeApp } from './platz/ZugaengeApp';
import { MeineDatenApp } from './platz/MeineDaten';
import { Einladung } from './mitglieder/Einladung';
import { Jahresabschluss } from './abschluss/Jahresabschluss';
import { MeineZeiten } from './jt/MeineZeiten';
import { Ablage } from './upload/Ablage';
import { tcoZusatz } from './dashboard/Arbeitsvorrat';
import { PlatzBuchen } from './platz/PlatzBuchen';
import { Platzverwaltung } from './platz/Platzverwaltung';
import { Serienbuchung } from './platz/Serienbuchung';
import { Dokumenteneingang } from './eingang/Dokumenteneingang';
import { SchadenMelden } from './instandhaltung/SchadenMelden';
import { Instandhaltung, InstandhaltungKapitel, InstandhaltungPaperless } from './instandhaltung/Instandhaltung';
import { Hallenschluessel, SchluesselKapitel } from './schluessel/Hallenschluessel';
import { SchluesselQuittung } from './schluessel/SchluesselQuittung';
import { api } from '@core/api';
import type { TileKpi } from '@core/platform';
import { H, TCO, eur } from './util';

// Kennzahlen der Startseitenkacheln (nutzen vorhandene Lese-Endpunkte)
const kpiMitglieder = async (): Promise<TileKpi> => {
  const l = await api.get<{ anzahl: Record<string, number> }>(`${TCO}/mitglieder/liste?status=AKTIV`);
  return { value: String(l.anzahl.AKTIV ?? 0), label: 'aktive Mitglieder' };
};
const kpiEingang = async (): Promise<TileKpi> => {
  const l = await api.get<{ offen: { pruefen: number; fehler: number } }>(`${TCO}/eingang/vorgaenge?status=fehler`);
  const n = l.offen.pruefen + l.offen.fehler;
  return { value: String(n), label: 'zu prüfen', state: l.offen.fehler ? 'Negative' : n ? 'Critical' : 'Positive' };
};
const kpiSchaden = async (): Promise<TileKpi> => {
  const l = await api.get<{ zeilen: { auswirkung: string }[] }>(`${TCO}/instandhaltung?filter=OFFEN`);
  const sicher = l.zeilen.some((z) => z.auswirkung === 'SICHERHEIT');
  return { value: String(l.zeilen.length), label: 'offen', state: sicher ? 'Negative' : l.zeilen.length ? 'Critical' : 'Positive' };
};
const kpiHalle = async (): Promise<TileKpi> => {
  const l = await api.get<{ personen: unknown[]; gesamtOffen: number }>(`${H}/personen?status=1,2,3,5&buchungen=1`);
  return { value: eur(l.gesamtOffen), label: 'offen', state: l.gesamtOffen > 0 ? 'Critical' : 'Positive' };
};

/** TC Oberthal – Vereinsportal (Port der abap2UI5-Apps) */
const mod: WebModule = {
  id: 'tco',
  name: 'TC Oberthal',
  icon: 'badge',
  home: { component: Dashboard, permission: 'tco.dashboard:display' },
  // Ablagefeld unten in der Navigation: Dateien hineinziehen → Paperless (mit Voreinstellung)
  sideWidgets: [{ component: Ablage, permission: 'tco.upload:execute' }],
  // Arbeitsvorrat der Startseite (#232, V2): Knopf „Zahlungsdaten“ an Einträgen „Überweisung an Einreicher“, „Bearbeiten“ an Kündigungen.
  // Den Hinweis „n neu“ zeigt der Kern am Menüeintrag „Start“ (web/src/arbeitsvorrat.tsx).
  arbeitsvorratZusatz: tcoZusatz,
  // Kapitel „TC Oberthal“ der App Einstellungen (Administration → Einstellungen, #232 E1) – weitere Kapitel (Tennishalle, Clubhaus,
  // Finanzen, Instandhaltung) folgen je Fachbereich
  // Abschnitte in der App Schnittstellen (Administration → Schnittstellen, #232 S1/S4)
  schnittstellen: [
    // Paperless-Felder, die bisher in den Fach-Apps standen: zur Schnittstelle, in den Block des Vereins
    { reiter: 'Paperless', id: 'fi', text: 'Finanzen: offene Belege', permission: 'tco.stammdaten:edit', component: VereinFiPaperless },
    { reiter: 'Paperless', id: 'clubhaus', text: 'Clubhaus: Abrechnung', permission: 'tco.clubhaus:edit', component: ClubhausPaperless },
    { reiter: 'Paperless', id: 'instandhaltung', text: 'Instandhaltung: Dokumente zur Auswahl', permission: 'tco.instandhaltung:admin', component: InstandhaltungPaperless },
    { reiter: 'SAP', id: 'sap', text: 'Übernahme aus SAP', permission: 'tco.import:execute', component: ImportTab },
  ],
  logos: [{ id: 'kopfband', text: 'Kopfband (weiß auf Orange)', permission: 'tco.stammdaten:edit', component: VereinLogo }],
  einstellungen: [
    { id: 'verein', text: 'Verein und Bank', icon: 'group', permission: 'tco.stammdaten:edit', component: VereinTab },
    { id: 'tennishalle', text: 'Tennishalle', icon: 'building', permission: 'tco.stammdaten:edit', component: VereinHalle },
    { id: 'finanzen', text: 'Finanzen', icon: 'loan', permission: 'tco.stammdaten:edit', component: VereinFinanzen },
    // Übersicht über alle Kapitel: welcher Vorgang bebucht welches Konto (#232, E4)
    { id: 'kontenfindung', text: 'Kontenfindung', icon: 'accounting-document-verification', permission: 'tco.stammdaten:edit|tco.soll:glaeubiger|tco.clubhaus:display|tco.verzehr:display|tco.schluessel:admin', component: Kontenfindung },
    { id: 'beitragseinzug', text: 'Beitragseinzug', icon: 'money-bills', permission: 'tco.soll:glaeubiger', component: GlaeubigerKapitel },
    { id: 'hallenschluessel', text: 'Hallenschlüssel', icon: 'key', permission: 'tco.schluessel:admin', component: SchluesselKapitel },
    { id: 'clubhaus', text: 'Clubhaus', icon: 'meal', permission: 'tco.clubhaus:edit', component: ClubhausKapitel },
    { id: 'verzehr', text: 'Verzehr', icon: 'cart', permission: 'tco.verzehr:admin', component: VerzehrKapitel },
    { id: 'instandhaltung', text: 'Instandhaltung', icon: 'technical-object', permission: 'tco.instandhaltung:admin', component: InstandhaltungKapitel },
    { id: 'mailtexte', text: 'E-Mail-Texte', icon: 'email', permission: 'tco.stammdaten:edit', component: MailtexteKapitel },
  ],
  // Stufe 1: TC Oberthal · Stufe 2: Bereiche · Stufe 3: Apps – Gliederung wie die Rollenpflege (Rechtekatalog in
  // modules/tco/server/index.ts; lose Apps der Stufe 2 stehen dort im Bereich „Allgemein“), geprüft in
  // server/test/menue_rollenpflege.test.ts (#232, N6). Das Zahnrad steht nur für Einstellungen (B4).
  nav: [
    {
      text: 'TC Oberthal',
      children: [
        { text: 'Vereinsübersicht', icon: 'business-objects-experience', path: '/tco/uebersicht', permission: 'tco.dashboard:display' },
        { text: 'Präsentationen', icon: 'ppt-attachment', path: '/tco/praesentationen', permission: 'tco.praesentation:display' },
        { text: 'Vereinskalender', icon: 'calendar', path: '/tco/kalender', permission: 'tco.kalender:anmelden|tco.kalender:edit' },
        // Mein Bereich (#232, N1): alles, was jemand für sich selbst tut – die Fachgruppen darunter enthalten nur noch Verwaltung
        {
          text: 'Mein Bereich', icon: 'person-placeholder',
          children: [
            // eine App für Mitglieder und Hallennutzer (#232, N2) – der Inhalt richtet sich danach, was man ist
            { text: 'Meine Daten', icon: 'customer', path: '/tco/meine-daten', permission: 'tco.meinedaten:edit|tco.meinkonto:edit' },
            { text: 'Platz buchen', icon: 'appointment', path: '/tco/platz-buchen', permission: 'tco.platzbuchung:edit' },
            { text: 'Mein Verzehr', icon: 'cart', path: '/tco/verzehr', permission: 'tco.verzehr:edit' },
            { text: 'Meine Trainingszeiten', icon: 'time-entry-request', path: '/tco/meine-zeiten', permission: 'tco.jtmeine:edit' },
            { text: 'Schaden melden', icon: 'camera', path: '/tco/schaden', permission: 'tco.schaden:melden' },
          ],
        },
        {
          text: 'Mitglieder', icon: 'group',
          children: [
            { text: 'Mitglieder', icon: 'employee', path: '/tco/mitglieder', permission: 'tco.mitglieder:display' },
            { text: 'Mitgliedergruppen', icon: 'tree', path: '/tco/gruppen', permission: 'tco.gruppen:display' },
            { text: 'Mitgliedsanträge', icon: 'personnel-view', path: '/tco/mitgliedsantraege', permission: 'tco.antraege:display' },
            // Zugänge (#232, N3): Registrierungen von Mitgliedern und Hallennutzern, Zuordnung, EP3-Abgleich an einer Stelle
            { text: 'Zugänge', icon: 'add-employee', path: '/tco/zugaenge', permission: 'tco.registrierung:mitglied|tco.platz:admin' },
            { text: 'Mitgliedsbeiträge', icon: 'money-bills', path: '/tco/beitraege', permission: 'tco.beitraege:display' },
            { text: 'Mitglieder-Analyse', icon: 'pie-chart', path: '/tco/analyse', permission: 'tco.analyse:display' },
          ],
        },
        {
          text: 'Sport', icon: 'competitor',
          children: [
            { text: 'Spielerdaten (nuLiga)', icon: 'competitor', path: '/tco/spielerdaten', permission: 'tco.sport:display' },
          ],
        },
        {
          text: 'Jugend', icon: 'family-care',
          children: [
            { text: 'Teilnehmer Jugendtraining', icon: 'family-protection', path: '/tco/teilnehmer', permission: 'tco.teilnehmer:display' },
            { text: 'Schnuppertraining', icon: 'physical-activity', path: '/tco/schnuppertraining', permission: 'tco.schnupper:display' },
            { text: 'Abrechnung Jugendtraining', icon: 'timesheet', path: '/tco/jugendtraining', permission: 'tco.jt:display' },
          ],
        },
        {
          text: 'Tennishalle', icon: 'building',
          children: [
            { text: 'Hallenabrechnung', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display' },
            { text: 'Hallenschlüssel', icon: 'key', path: '/tco/hallenschluessel', permission: 'tco.schluessel:display' },
            { text: 'Serienbuchung', icon: 'repost', path: '/tco/serienbuchung', permission: 'tco.platz:serie' },
            { text: 'Platzverwaltung', icon: 'map', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
            // Stammdaten stehen als letzte App ihres Fachbereichs (#232, E5) – eine Menügruppe „Einstellungen“ gibt es im Fachbaum nicht mehr
            // alle Preise an einer Stelle (#232, N4): sichtbar für alle, die eine der Sichten sehen dürfen
            { text: 'Produkte und Preise', icon: 'product', path: '/tco/produkte', permission: 'tco.produkte:display|tco.halle:display|tco.clubhaus:display|tco.verzehr:display' },
          ],
        },
        {
          text: 'Clubhaus', icon: 'meal',
          children: [
            { text: 'Clubhausabrechnung', icon: 'receipt', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
            { text: 'Theke', icon: 'payment-approval', path: '/tco/theke', permission: 'tco.verzehr:theke' },
            { text: 'Verzehrbuch', icon: 'course-book', path: '/tco/verzehrbuch', permission: 'tco.verzehr:display' },
          ],
        },
        {
          text: 'Instandhaltung', icon: 'technical-object',
          children: [
            { text: 'Schadensmeldungen', icon: 'wrench', path: '/tco/instandhaltung', permission: 'tco.instandhaltung:display' },
          ],
        },
        {
          text: 'Finanzen', icon: 'loan',
          children: [
            { text: 'Sollstellungen', icon: 'collections-insight', path: '/tco/sollstellung', permission: 'tco.soll:display' },
            { text: 'FI-Belege', icon: 'accounting-document-verification', path: '/tco/fi', permission: 'tco.fi:display' },
            { text: 'Beitragsforecast', icon: 'trend-up', path: '/tco/forecast', permission: 'tco.forecast:display' },
            { text: 'Einnahmen und Ausgaben', icon: 'bar-chart', path: '/tco/finanz', permission: 'tco.finanz:display' },
            { text: 'Jahresabschluss', icon: 'expense-report', path: '/tco/abschluss', permission: 'tco.abschluss:display' },
            { text: 'Kontenstamm', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
          ],
        },
        {
          text: 'Dokumente', icon: 'documents',
          children: [
            { text: 'Dokumenteneingang', icon: 'inbox', path: '/tco/dokumenteneingang', permission: 'tco.eingang:display' },
            { text: 'Dokumenten-Upload', icon: 'upload-to-cloud', path: '/tco/upload', permission: 'tco.upload:execute' },
          ],
        },
      ],
    },
  ],
  routes: [
    { path: '/tco/mitglieder', component: Mitglieder, permission: 'tco.mitglieder:display' },
    // alte Adresse (E-Mails, Lesezeichen): dieselbe App
    { path: '/tco/meine-mitgliedschaft', component: MeineDatenApp, permission: 'tco.meinedaten:edit' },
    { path: '/tco/gruppen', component: Gruppen, permission: 'tco.gruppen:display' },
    { path: '/tco/halle', component: Hallenabrechnung, permission: 'tco.halle:display' },
    // bisherige App „Hallenpreise“: jetzt die Sicht „Hallenpreise (Wochenplan)“ von „Produkte und Preise“ – alte Adresse bleibt gültig
    { path: '/tco/hallenpreise', component: ZuHallenpreisen, permission: 'tco.halle:display' },
    { path: '/tco/platz-buchen', component: PlatzBuchen, permission: 'tco.platzbuchung:edit' },
    { path: '/tco/meine-daten', component: MeineDatenApp, permission: 'tco.meinedaten:edit|tco.meinkonto:edit' },
    { path: '/tco/platzverwaltung', component: Platzverwaltung, permission: 'tco.platz:admin' },
    { path: '/tco/serienbuchung', component: Serienbuchung, permission: 'tco.platz:serie' },
    { path: '/tco/sollstellung', component: Sollstellung, permission: 'tco.soll:display' },
    { path: '/tco/jugendtraining', component: Jugendtraining, permission: 'tco.jt:display' },
    { path: '/tco/clubhaus', component: Clubhaus, permission: 'tco.clubhaus:display' },
    { path: '/tco/kalender', component: Kalender, permission: 'tco.kalender:anmelden|tco.kalender:edit' },
    { path: '/tco/verzehr', component: MeinVerzehr, permission: 'tco.verzehr:edit' },
    { path: '/tco/theke', component: Theke, permission: 'tco.verzehr:theke' },
    { path: '/tco/verzehrbuch', component: Verzehrbuch, permission: 'tco.verzehr:display' },
    { path: '/tco/fi', component: FiBelege, permission: 'tco.fi:display' },
    // bisherige App „Stammdaten“: Vereinsdaten sind ein Kapitel der Einstellungen, die SAP-Übernahme ein Abschnitt der Schnittstellen
    { path: '/tco/stammdaten', component: ZuVereinEinstellungen, permission: 'tco.stammdaten:edit' },
    { path: '/tco/uebersicht', component: DashboardPage, permission: 'tco.dashboard:display' },
    { path: '/tco/praesentationen', component: Praesentationen, permission: 'tco.praesentation:display' },
    { path: '/tco/spielerdaten', component: Spielerdaten, permission: 'tco.sport:display' },
    { path: '/tco/analyse', component: Analyse, permission: 'tco.analyse:display' },
    { path: '/tco/teilnehmer', component: Teilnehmer, permission: 'tco.teilnehmer:display' },
    { path: '/tco/upload', component: Upload, permission: 'tco.upload:execute' },
    { path: '/tco/beitraege', component: Beitraege, permission: 'tco.beitraege:display' },
    { path: '/tco/forecast', component: Forecast, permission: 'tco.forecast:display' },
    { path: '/tco/finanz', component: Finanz, permission: 'tco.finanz:display' },
    { path: '/tco/konten', component: Konten, permission: 'tco.konten:display' },
    { path: '/tco/produkte', component: Produkte, permission: 'tco.produkte:display|tco.halle:display|tco.clubhaus:display|tco.verzehr:display' },
    { path: '/tco/mitgliedsantraege', component: Mitgliedsantraege, permission: 'tco.antraege:display' },
    { path: '/tco/schnuppertraining', component: SchnupperVerwaltung, permission: 'tco.schnupper:display' },
    { path: '/tco/zugaenge', component: ZugaengeApp, permission: 'tco.registrierung:mitglied|tco.platz:admin' },
    // alte Adresse (Arbeitsvorrat, Lesezeichen): dieselbe App, Reiter Registrierungen → Mitglieder
    { path: '/tco/registrierungen', component: ZugaengeApp, permission: 'tco.registrierung:mitglied' },
    { path: '/tco/abschluss', component: Jahresabschluss, permission: 'tco.abschluss:display' },
    { path: '/tco/meine-zeiten', component: MeineZeiten, permission: 'tco.jtmeine:edit' },
    { path: '/tco/dokumenteneingang', component: Dokumenteneingang, permission: 'tco.eingang:display' },
    { path: '/tco/schaden', component: SchadenMelden, permission: 'tco.schaden:melden' },
    { path: '/tco/instandhaltung', component: Instandhaltung, permission: 'tco.instandhaltung:display' },
    { path: '/tco/hallenschluessel', component: Hallenschluessel, permission: 'tco.schluessel:display' },
  ],
  // QR-Code an der Anlage: nach der Anmeldung direkt zum vorbelegten Formular
  // Einladungslink einer Veranstaltung (/tco/kalender?veranstaltung=…): nach der Anmeldung direkt dorthin
  nachAnmeldung: ['/tco/schaden', '/tco/kalender'],
  oeffentlich: [
    { pfad: '/beitritt', component: Beitritt },
    { pfad: '/schnuppertraining', component: Schnuppertraining },
    { pfad: '/registrierung-bestaetigen', component: RegistrierungBestaetigen },
    { pfad: '/einladung', component: Einladung },
    { pfad: '/schluessel-quittung', component: SchluesselQuittung },
  ],
  tiles: [
    { text: 'Vereinsübersicht', subtitle: 'Kennzahlen Mitglieder, Clubhaus, Finanzen, Jugend, Halle, Instandhaltung', icon: 'business-objects-experience', path: '/tco/uebersicht', permission: 'tco.dashboard:display' },
    { text: 'Kontenstamm', subtitle: 'Konten, Verwendung je Jahr, Anfangsbestände', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
    { text: 'Produkte und Preise', subtitle: 'Alle Preise: Halle, Getränke, Speisen – je Zeitraum, mit Erlöskonten', icon: 'product', path: '/tco/produkte', permission: 'tco.produkte:display|tco.halle:display|tco.clubhaus:display|tco.verzehr:display' },
    { text: 'Mitglieder', subtitle: 'Stammdaten, Verträge, SEPA, Unterlagen', icon: 'group', path: '/tco/mitglieder', permission: 'tco.mitglieder:display', kpi: kpiMitglieder },
    { text: 'Mitgliedergruppen', subtitle: 'Kategorien, Gruppen und Mannschaften im Baum', icon: 'tree', path: '/tco/gruppen', permission: 'tco.gruppen:display' },
    { text: 'Mitgliedsbeiträge', subtitle: 'Beitragsarten und Beträge je Zeitraum', icon: 'money-bills', path: '/tco/beitraege', permission: 'tco.beitraege:display' },
    { text: 'Mitglieder-Analyse', subtitle: 'Altersstruktur, Ein-/Austritte, Beiträge, Varianten', icon: 'pie-chart', path: '/tco/analyse', permission: 'tco.analyse:display' },
    { text: 'Spielerdaten (nuLiga)', subtitle: 'ID-Nr. und LK aus der Verbandsliste abgleichen', icon: 'competitor', path: '/tco/spielerdaten', permission: 'tco.sport:display' },
    { text: 'Teilnehmer Jugendtraining', subtitle: 'Trefferliste, Mitglieder/Nichtmitglieder, E-Mail', icon: 'family-protection', path: '/tco/teilnehmer', permission: 'tco.teilnehmer:display' },
    { text: 'Schnuppertraining', subtitle: 'Anmeldungen, Einheiten, Beitrittslink', icon: 'physical-activity', path: '/tco/schnuppertraining', permission: 'tco.schnupper:display' },
    { text: 'Abrechnung Jugendtraining', subtitle: 'Trainingszeiten, Zeitnachweise, Trainerentgelte', icon: 'family-care', path: '/tco/jugendtraining', permission: 'tco.jt:display' },
    { text: 'Meine Trainingszeiten', subtitle: 'Eigene Zeiten zurückmelden, Zeitnachweise ansehen', icon: 'time-entry-request', path: '/tco/meine-zeiten', permission: 'tco.jtmeine:edit' },
    { text: 'Hallenabrechnung', subtitle: 'EP3-Buchungen abrechnen', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display', kpi: kpiHalle },
    { text: 'Platz buchen', subtitle: 'Freiplätze und Halle – eigene Buchungen mit Preisen', icon: 'appointment', path: '/tco/platz-buchen', permission: 'tco.platzbuchung:edit' },
    { text: 'Meine Daten', subtitle: 'Kontakt, Bankverbindung, Verträge, Kündigung', icon: 'customer', path: '/tco/meine-daten', permission: 'tco.meinedaten:edit|tco.meinkonto:edit' },
    { text: 'Serienbuchung', subtitle: 'Hallenwart: mehrere Plätze, Stunden, Abos', icon: 'repost', path: '/tco/serienbuchung', permission: 'tco.platz:serie' },
    { text: 'Platzverwaltung', subtitle: 'Plätze, Buchungsregeln, Belegung, Abos', icon: 'map', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
    { text: 'Clubhausabrechnung', subtitle: 'Getränkerechnungen, Forderungsliste, Absatz', icon: 'meal', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
    { text: 'Vereinskalender', subtitle: 'Veranstaltungen, Mannschaften, An- und Abmeldung', icon: 'calendar', path: '/tco/kalender', permission: 'tco.kalender:anmelden|tco.kalender:edit' },
    { text: 'Mein Verzehr', subtitle: 'Verzehr im Clubhaus auf das eigene Konto anschreiben', icon: 'cart', path: '/tco/verzehr', permission: 'tco.verzehr:edit' },
    { text: 'Theke', subtitle: 'Gäste kassieren, Belege senden, Mitglieder anschreiben', icon: 'payment-approval', path: '/tco/theke', permission: 'tco.verzehr:theke' },
    { text: 'Verzehrbuch', subtitle: 'Alle Positionen, Belege, Monatsabschluss, Preisliste', icon: 'course-book', path: '/tco/verzehrbuch', permission: 'tco.verzehr:display' },
    { text: 'Schaden melden', subtitle: 'Etwas kaputt auf der Anlage? Mit Foto melden', icon: 'camera', path: '/tco/schaden', permission: 'tco.schaden:melden' },
    { text: 'Schadensmeldungen', subtitle: 'Meldungen bearbeiten, Plätze sperren', icon: 'wrench', path: '/tco/instandhaltung', permission: 'tco.instandhaltung:display', kpi: kpiSchaden },
    { text: 'Sollstellungen', subtitle: 'Beitragseinzug per SEPA-Lastschrift', icon: 'collections-insight', path: '/tco/sollstellung', permission: 'tco.soll:display' },
    { text: 'FI-Belege', subtitle: 'Bankimport, Belege, Storno', icon: 'accounting-document-verification', path: '/tco/fi', permission: 'tco.fi:display' },
    { text: 'Beitragsforecast', subtitle: 'Hochrechnung der Beitragseinnahmen', icon: 'trend-up', path: '/tco/forecast', permission: 'tco.forecast:display' },
    { text: 'Einnahmen und Ausgaben', subtitle: 'Jahresübersicht, Geldkonten, Liquidität', icon: 'bar-chart', path: '/tco/finanz', permission: 'tco.finanz:display' },
    { text: 'Jahresabschluss', subtitle: 'EAR, Vermögensübersicht, Anlagevermögen', icon: 'expense-report', path: '/tco/abschluss', permission: 'tco.abschluss:display' },
    { text: 'Dokumenten-Upload', subtitle: 'Belege gesammelt nach Paperless', icon: 'upload-to-cloud', path: '/tco/upload', permission: 'tco.upload:execute' },
    { text: 'Dokumenteneingang', subtitle: 'E-Mails und Anhänge nach Regeln ablegen, Prüfliste', icon: 'inbox', path: '/tco/dokumenteneingang', permission: 'tco.eingang:display', kpi: kpiEingang },
  ],
};

export default mod;
