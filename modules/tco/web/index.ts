import type { WebModule } from '@core/platform';
import { Hallenabrechnung } from './Hallenabrechnung';
import { Hallenpreise } from './Hallenpreise';
import { TcoStammdaten } from './Stammdaten';
import { FiBelege } from './fi/FiBelege';
import { Sollstellung } from './soll/Sollstellung';
import { Jugendtraining } from './jt/Jugendtraining';
import { Clubhaus } from './clubhaus/Clubhaus';
import { Mitglieder } from './mitglieder/Mitglieder';
import { Dashboard, DashboardPage } from './dashboard/Dashboard';
import { Analyse } from './analyse/Analyse';
import { Teilnehmer } from './teilnehmer/Teilnehmer';
import { Upload } from './upload/Upload';
import { Beitraege } from './beitraege/Beitraege';
import { Forecast } from './forecast/Forecast';
import { Finanz } from './finanz/Finanz';
import { Konten } from './konten/Konten';
import { Jahresabschluss } from './abschluss/Jahresabschluss';
import { MeineZeiten } from './jt/MeineZeiten';
import { Ablage } from './upload/Ablage';
import { PlatzBuchen } from './platz/PlatzBuchen';
import { Platzverwaltung } from './platz/Platzverwaltung';
import { api } from '@core/api';
import type { TileKpi } from '@core/platform';
import { H, TCO, eur } from './util';

// Kennzahlen der Startseitenkacheln (nutzen vorhandene Lese-Endpunkte)
const kpiMitglieder = async (): Promise<TileKpi> => {
  const l = await api.get<{ anzahl: Record<string, number> }>(`${TCO}/mitglieder/liste?status=AKTIV`);
  return { value: String(l.anzahl.AKTIV ?? 0), label: 'aktive Mitglieder' };
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
        {
          text: 'Einstellungen', icon: 'action-settings',
          children: [
            { text: 'Stammdaten', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
            { text: 'Kontenstamm', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
          ],
        },
        {
          text: 'Mitglieder', icon: 'group',
          children: [
            { text: 'Mitglieder', icon: 'employee', path: '/tco/mitglieder', permission: 'tco.mitglieder:display' },
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
            { text: 'Platzverwaltung', icon: 'action-settings', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
          ],
        },
        {
          text: 'Clubhaus', icon: 'meal',
          children: [
            { text: 'Clubhausabrechnung', icon: 'receipt', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
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
      ],
    },
  ],
  routes: [
    { path: '/tco/mitglieder', component: Mitglieder, permission: 'tco.mitglieder:display' },
    { path: '/tco/halle', component: Hallenabrechnung, permission: 'tco.halle:display' },
    { path: '/tco/hallenpreise', component: Hallenpreise, permission: 'tco.halle:display' },
    { path: '/tco/platz-buchen', component: PlatzBuchen, permission: 'tco.platzbuchung:edit' },
    { path: '/tco/platzverwaltung', component: Platzverwaltung, permission: 'tco.platz:admin' },
    { path: '/tco/sollstellung', component: Sollstellung, permission: 'tco.soll:display' },
    { path: '/tco/jugendtraining', component: Jugendtraining, permission: 'tco.jt:display' },
    { path: '/tco/clubhaus', component: Clubhaus, permission: 'tco.clubhaus:display' },
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
    { path: '/tco/abschluss', component: Jahresabschluss, permission: 'tco.abschluss:display' },
    { path: '/tco/meine-zeiten', component: MeineZeiten, permission: 'tco.jtmeine:edit' },
  ],
  tiles: [
    { text: 'Vereinsübersicht', subtitle: 'Kennzahlen Mitglieder, Clubhaus, Finanzen, Jugend, Halle', icon: 'business-objects-experience', path: '/tco/uebersicht', permission: 'tco.dashboard:display' },
    { text: 'Stammdaten', subtitle: 'Verein, Anbindungen, SAP-Übernahme', icon: 'database', path: '/tco/stammdaten', permission: 'tco.stammdaten:edit' },
    { text: 'Kontenstamm', subtitle: 'Konten, Verwendung je Jahr, Anfangsbestände', icon: 'list', path: '/tco/konten', permission: 'tco.konten:display' },
    { text: 'Mitglieder', subtitle: 'Stammdaten, Verträge, SEPA, Unterlagen', icon: 'group', path: '/tco/mitglieder', permission: 'tco.mitglieder:display', kpi: kpiMitglieder },
    { text: 'Mitgliedsbeiträge', subtitle: 'Beitragsarten und Beträge je Zeitraum', icon: 'money-bills', path: '/tco/beitraege', permission: 'tco.beitraege:display' },
    { text: 'Mitglieder-Analyse', subtitle: 'Altersstruktur, Ein-/Austritte, Beiträge, Varianten', icon: 'pie-chart', path: '/tco/analyse', permission: 'tco.analyse:display' },
    { text: 'Teilnehmer Jugendtraining', subtitle: 'Trefferliste, Mitglieder/Nichtmitglieder, E-Mail', icon: 'family-protection', path: '/tco/teilnehmer', permission: 'tco.teilnehmer:display' },
    { text: 'Abrechnung Jugendtraining', subtitle: 'Trainingszeiten, Zeitnachweise, Trainerentgelte', icon: 'family-care', path: '/tco/jugendtraining', permission: 'tco.jt:display' },
    { text: 'Meine Trainingszeiten', subtitle: 'Eigene Zeiten zurückmelden, Zeitnachweise ansehen', icon: 'time-entry-request', path: '/tco/meine-zeiten', permission: 'tco.jtmeine:edit' },
    { text: 'Hallenpreise', subtitle: 'Produkte und Preismatrix', icon: 'lead', path: '/tco/hallenpreise', permission: 'tco.halle:display' },
    { text: 'Hallenabrechnung', subtitle: 'EP3-Buchungen abrechnen', icon: 'sales-order', path: '/tco/halle', permission: 'tco.halle:display', kpi: kpiHalle },
    { text: 'Platz buchen', subtitle: 'Freiplätze und Halle – eigene Buchungen mit Preisen', icon: 'appointment', path: '/tco/platz-buchen', permission: 'tco.platzbuchung:edit' },
    { text: 'Platzverwaltung', subtitle: 'Plätze, Buchungsregeln, Belegung, Abos', icon: 'action-settings', path: '/tco/platzverwaltung', permission: 'tco.platz:admin' },
    { text: 'Clubhausabrechnung', subtitle: 'Getränkerechnungen, Forderungsliste, Absatz', icon: 'meal', path: '/tco/clubhaus', permission: 'tco.clubhaus:display' },
    { text: 'Sollstellungen', subtitle: 'Beitragseinzug per SEPA-Lastschrift', icon: 'collections-insight', path: '/tco/sollstellung', permission: 'tco.soll:display' },
    { text: 'FI-Belege', subtitle: 'Bankimport, Belege, Storno', icon: 'accounting-document-verification', path: '/tco/fi', permission: 'tco.fi:display' },
    { text: 'Beitragsforecast', subtitle: 'Hochrechnung der Beitragseinnahmen', icon: 'trend-up', path: '/tco/forecast', permission: 'tco.forecast:display' },
    { text: 'Einnahmen und Ausgaben', subtitle: 'Jahresübersicht, Geldkonten, Liquidität', icon: 'bar-chart', path: '/tco/finanz', permission: 'tco.finanz:display' },
    { text: 'Jahresabschluss', subtitle: 'EAR, Vermögensübersicht, Anlagevermögen', icon: 'expense-report', path: '/tco/abschluss', permission: 'tco.abschluss:display' },
    { text: 'Dokumenten-Upload', subtitle: 'Belege gesammelt nach Paperless', icon: 'upload-to-cloud', path: '/tco/upload', permission: 'tco.upload:execute' },
  ],
};

export default mod;
