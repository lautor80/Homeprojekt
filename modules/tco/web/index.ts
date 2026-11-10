import type { WebModule } from '@core/platform';
import { Hallenabrechnung } from './Hallenabrechnung';
import { Hallenpreise } from './Hallenpreise';
import { TcoStammdaten } from './Stammdaten';
import { FiBelege } from './fi/FiBelege';
import { Sollstellung } from './soll/Sollstellung';
import { Jugendtraining } from './jt/Jugendtraining';
import { Clubhaus } from './clubhaus/Clubhaus';
import { MeinVerzehr } from './verzehr/MeinVerzehr';
import { Theke } from './verzehr/Theke';
import { Verzehrbuch } from './verzehr/Verzehrbuch';
import { Kalender } from './kalender/Kalender';
import { Mitglieder } from './mitglieder/Mitglieder';
import { MeineMitgliedschaft } from './mitglieder/MeineMitgliedschaft';
import { Gruppen } from './gruppen/Gruppen';
import { Dashboard, DashboardPage } from './dashboard/Dashboard';
import { Analyse } from './analyse/Analyse';
import { Teilnehmer } from './teilnehmer/Teilnehmer';
import { Upload } from './upload/Upload';
import { Beitraege } from './beitraege/Beitraege';
import { Forecast } from './forecast/Forecast';
import { Finanz } from './finanz/Finanz';
import { Konten } from './konten/Konten';
import { Produkte } from './produkte/Produkte';
import { Beitritt } from './antrag/Beitritt';
import { Mitgliedsantraege } from './antrag/Mitgliedsantraege';
import { Schnuppertraining } from './schnupper/Schnuppertraining';
import { SchnupperVerwaltung } from './schnupper/SchnupperVerwaltung';
import { RegistrierungBestaetigen } from './platz/RegistrierungBestaetigen';
import { MitgliedRegistrierungen } from './platz/MitgliedRegistrierungen';
import { MeineDaten } from './platz/MeineDaten';
import { Einladung } from './mitglieder/Einladung';
import { Jahresabschluss } from './abschluss/Jahresabschluss';
import { MeineZeiten } from './jt/MeineZeiten';
import { Ablage } from './upload/Ablage';
import { PlatzBuchen } from './platz/PlatzBuchen';
import { Platzverwaltung } from './platz/Platzverwaltung';
import { Serienbuchung } from './platz/Serienbuchung';
import { Dokumenteneingang } from './eingang/Dokumenteneingang';
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
  // Stufe 1: TC Oberthal · Stufe 2: Bereiche · Stufe 3: Apps (Gliederung wie die Rollenpflege)
  nav: [
    {
      text: 'TC Oberthal',
      children: [
        { text: 'Vereinsübersicht', icon: 'business-objects-experience', path: '/tco/uebersicht', permission: 'tco.dashboard:display' },
        { text: 'Vereinskalender', icon: 'calendar', path: '/tco/kalender', permission: 'tco.kalender:anmelden|tco.kalender:edit' },
        {
          text: 'Einstellungen', icon: 'action-settings',
          children: [
            { text: 'Stammdaten', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
            { text: 'Kontenstamm', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
            { text: 'Produkte', icon: 'product', path: '/tco/produkte', permission: 'tco.produkte:display' },
          ],
        },
        {
          text: 'Mitglieder', icon: 'group',
          children: [
            { text: 'Meine Mitgliedschaft', icon: 'customer', path: '/tco/meine-mitgliedschaft', permission: 'tco.meinedaten:edit' },
            { text: 'Mitglieder', icon: 'employee', path: '/tco/mitglieder', permission: 'tco.mitglieder:display' },
            { text: 'Mitgliedergruppen', icon: 'tree', path: '/tco/gruppen', permission: 'tco.gruppen:display' },
            { text: 'Mitgliedsanträge', icon: 'personnel-view', path: '/tco/mitgliedsantraege', permission: 'tco.antraege:display' },
            { text: 'Schnuppertraining', icon: 'physical-activity', path: '/tco/schnuppertraining', permission: 'tco.schnupper:display' },
            { text: 'Registrierungen', icon: 'add-employee', path: '/tco/registrierungen', permission: 'tco.registrierung:mitglied' },
            { text: 'Mitgliedsbeiträge', icon: 'money-bills', path: '/tco/beitraege', permission: 'tco.beitraege:display' },
            { text: 'Mitglieder-Analyse', icon: 'pie-chart', path: '/tco/analyse', permission: 'tco.analyse:display' },
          ],
        },
        {
          text: 'Jugend', icon: 'family-care',
          children: [
            { text: 'Teilnehmer Jugendtraining', icon: 'family-protection', path: '/tco/teilnehmer', permission: 'tco.teilnehmer:display' },
            { text: 'Abrechnung Jugendtraining', icon: 'timesheet', path: '/tco/jugendtraining', permission: 'tco.jt:display' },
            { text: 'Meine Trainingszeiten', icon: 'time-entry-request', path: '/tco/meine-zeiten', permission: 'tco.jtmeine:edit' },
          ],
        },
        {
          text: 'Tennishalle', icon: 'building',
          children: [
            { text: 'Hallenpreise', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
            { text: 'Hallenabrechnung', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display' },
            { text: 'Platz buchen', icon: 'appointment', path: '/tco/platz-buchen', permission: 'tco.platzbuchung:edit' },
            { text: 'Meine Daten', icon: 'customer', path: '/tco/meine-daten', permission: 'tco.meinkonto:edit' },
            { text: 'Serienbuchung', icon: 'repost', path: '/tco/serienbuchung', permission: 'tco.platz:serie' },
            { text: 'Platzverwaltung', icon: 'action-settings', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
          ],
        },
        {
          text: 'Clubhaus', icon: 'meal',
          children: [
            { text: 'Clubhausabrechnung', icon: 'receipt', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
            { text: 'Mein Verzehr', icon: 'cart', path: '/tco/verzehr', permission: 'tco.verzehr:edit' },
            { text: 'Theke', icon: 'payment-approval', path: '/tco/theke', permission: 'tco.verzehr:theke' },
            { text: 'Verzehrbuch', icon: 'sales-order', path: '/tco/verzehrbuch', permission: 'tco.verzehr:display' },
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
            { text: 'Dokumenten-Upload', icon: 'upload-to-cloud', path: '/tco/upload', permission: 'tco.upload:execute' },
          ],
        },
        {
          text: 'Dokumente', icon: 'documents',
          children: [
            { text: 'Dokumenteneingang', icon: 'inbox', path: '/tco/dokumenteneingang', permission: 'tco.eingang:display' },
          ],
        },
      ],
    },
  ],
  routes: [
    { path: '/tco/mitglieder', component: Mitglieder, permission: 'tco.mitglieder:display' },
    { path: '/tco/meine-mitgliedschaft', component: MeineMitgliedschaft, permission: 'tco.meinedaten:edit' },
    { path: '/tco/gruppen', component: Gruppen, permission: 'tco.gruppen:display' },
    { path: '/tco/halle', component: Hallenabrechnung, permission: 'tco.halle:display' },
    { path: '/tco/hallenpreise', component: Hallenpreise, permission: 'tco.halle:display' },
    { path: '/tco/platz-buchen', component: PlatzBuchen, permission: 'tco.platzbuchung:edit' },
    { path: '/tco/meine-daten', component: MeineDaten, permission: 'tco.meinkonto:edit' },
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
    { path: '/tco/stammdaten', component: TcoStammdaten, permission: 'tco.stammdaten:edit' },
    { path: '/tco/uebersicht', component: DashboardPage, permission: 'tco.dashboard:display' },
    { path: '/tco/analyse', component: Analyse, permission: 'tco.analyse:display' },
    { path: '/tco/teilnehmer', component: Teilnehmer, permission: 'tco.teilnehmer:display' },
    { path: '/tco/upload', component: Upload, permission: 'tco.upload:execute' },
    { path: '/tco/beitraege', component: Beitraege, permission: 'tco.beitraege:display' },
    { path: '/tco/forecast', component: Forecast, permission: 'tco.forecast:display' },
    { path: '/tco/finanz', component: Finanz, permission: 'tco.finanz:display' },
    { path: '/tco/konten', component: Konten, permission: 'tco.konten:display' },
    { path: '/tco/produkte', component: Produkte, permission: 'tco.produkte:display' },
    { path: '/tco/mitgliedsantraege', component: Mitgliedsantraege, permission: 'tco.antraege:display' },
    { path: '/tco/schnuppertraining', component: SchnupperVerwaltung, permission: 'tco.schnupper:display' },
    { path: '/tco/registrierungen', component: MitgliedRegistrierungen, permission: 'tco.registrierung:mitglied' },
    { path: '/tco/abschluss', component: Jahresabschluss, permission: 'tco.abschluss:display' },
    { path: '/tco/meine-zeiten', component: MeineZeiten, permission: 'tco.jtmeine:edit' },
    { path: '/tco/dokumenteneingang', component: Dokumenteneingang, permission: 'tco.eingang:display' },
  ],
  oeffentlich: [
    { pfad: '/beitritt', component: Beitritt },
    { pfad: '/schnuppertraining', component: Schnuppertraining },
    { pfad: '/registrierung-bestaetigen', component: RegistrierungBestaetigen },
    { pfad: '/einladung', component: Einladung },
  ],
  tiles: [
    { text: 'Vereinsübersicht', subtitle: 'Kennzahlen Mitglieder, Clubhaus, Finanzen, Jugend, Halle', icon: 'business-objects-experience', path: '/tco/uebersicht', permission: 'tco.dashboard:display' },
    { text: 'Stammdaten', subtitle: 'Verein, Anbindungen, SAP-Übernahme', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
    { text: 'Kontenstamm', subtitle: 'Konten, Verwendung je Jahr, Anfangsbestände', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
    { text: 'Produkte', subtitle: 'Produkte, Preise je Zeitraum, Erlöskonten', icon: 'product', path: '/tco/produkte', permission: 'tco.produkte:display' },
    { text: 'Meine Mitgliedschaft', subtitle: 'Eigene Daten, Bankverbindung, Verträge, Kündigung', icon: 'customer', path: '/tco/meine-mitgliedschaft', permission: 'tco.meinedaten:edit' },
    { text: 'Mitglieder', subtitle: 'Stammdaten, Verträge, SEPA, Unterlagen', icon: 'group', path: '/tco/mitglieder', permission: 'tco.mitglieder:display', kpi: kpiMitglieder },
    { text: 'Schnuppertraining', subtitle: 'Anmeldungen, Einheiten, Beitrittslink', icon: 'physical-activity', path: '/tco/schnuppertraining', permission: 'tco.schnupper:display' },
    { text: 'Mitgliedergruppen', subtitle: 'Kategorien, Gruppen und Mannschaften im Baum', icon: 'tree', path: '/tco/gruppen', permission: 'tco.gruppen:display' },
    { text: 'Mitgliedsbeiträge', subtitle: 'Beitragsarten und Beträge je Zeitraum', icon: 'money-bills', path: '/tco/beitraege', permission: 'tco.beitraege:display' },
    { text: 'Mitglieder-Analyse', subtitle: 'Altersstruktur, Ein-/Austritte, Beiträge, Varianten', icon: 'pie-chart', path: '/tco/analyse', permission: 'tco.analyse:display' },
    { text: 'Teilnehmer Jugendtraining', subtitle: 'Trefferliste, Mitglieder/Nichtmitglieder, E-Mail', icon: 'family-protection', path: '/tco/teilnehmer', permission: 'tco.teilnehmer:display' },
    { text: 'Abrechnung Jugendtraining', subtitle: 'Trainingszeiten, Zeitnachweise, Trainerentgelte', icon: 'family-care', path: '/tco/jugendtraining', permission: 'tco.jt:display' },
    { text: 'Meine Trainingszeiten', subtitle: 'Eigene Zeiten zurückmelden, Zeitnachweise ansehen', icon: 'time-entry-request', path: '/tco/meine-zeiten', permission: 'tco.jtmeine:edit' },
    { text: 'Hallenpreise', subtitle: 'Produkte und Preismatrix', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
    { text: 'Hallenabrechnung', subtitle: 'EP3-Buchungen abrechnen', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display', kpi: kpiHalle },
    { text: 'Platz buchen', subtitle: 'Freiplätze und Halle – eigene Buchungen mit Preisen', icon: 'appointment', path: '/tco/platz-buchen', permission: 'tco.platzbuchung:edit' },
    { text: 'Meine Daten', subtitle: 'Anschrift, E-Mail und Telefon pflegen', icon: 'customer', path: '/tco/meine-daten', permission: 'tco.meinkonto:edit' },
    { text: 'Serienbuchung', subtitle: 'Hallenwart: mehrere Plätze, Stunden, Abos', icon: 'repost', path: '/tco/serienbuchung', permission: 'tco.platz:serie' },
    { text: 'Platzverwaltung', subtitle: 'Plätze, Buchungsregeln, Belegung, Abos', icon: 'action-settings', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
    { text: 'Clubhausabrechnung', subtitle: 'Getränkerechnungen, Forderungsliste, Absatz', icon: 'meal', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
    { text: 'Vereinskalender', subtitle: 'Veranstaltungen, Mannschaften, An- und Abmeldung', icon: 'calendar', path: '/tco/kalender', permission: 'tco.kalender:anmelden|tco.kalender:edit' },
    { text: 'Mein Verzehr', subtitle: 'Verzehr im Clubhaus auf das eigene Konto anschreiben', icon: 'cart', path: '/tco/verzehr', permission: 'tco.verzehr:edit' },
    { text: 'Theke', subtitle: 'Gäste kassieren, Belege senden, Mitglieder anschreiben', icon: 'payment-approval', path: '/tco/theke', permission: 'tco.verzehr:theke' },
    { text: 'Verzehrbuch', subtitle: 'Alle Positionen, Belege, Monatsabschluss, Preisliste', icon: 'sales-order', path: '/tco/verzehrbuch', permission: 'tco.verzehr:display' },
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
