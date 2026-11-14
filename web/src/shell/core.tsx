import type { NavEntry, RouteDef } from '../platform';
import { HomePage } from '../pages/HomePage';
import { UsersPage } from '../pages/UsersPage';
import { RolesPage } from '../pages/RolesPage';
import { RollenmatrixPage } from '../pages/RollenmatrixPage';
import { AuditPage } from '../pages/AuditPage';
import { EinstellungenPage } from '../pages/EinstellungenPage';
import { SchnittstellenPage, ZuAnbindungen, ZuApiSchluessel, ZuPaperlessZuordnung } from '../pages/SchnittstellenPage';
import { BackupPage } from '../pages/BackupPage';
import { StatistikPage } from '../pages/StatistikPage';
import { SperrenPage } from '../pages/SperrenPage';
import { TabellenPage } from '../pages/TabellenPage';
import { MailProtokollPage } from '../pages/MailProtokollPage';
import { FunktionenPage } from '../pages/FunktionenPage';

export const coreNav: { home: NavEntry; admin: NavEntry } = {
  home: { text: 'Start', icon: 'home', path: '/' },
  admin: {
    text: 'Administration',
    einruecken: true,
    // Fünf Gruppen (#232, A1) – dieselbe Gliederung wie die Rollenpflege (server/src/permissions.ts),
    // geprüft in server/test/menue_rollenpflege.test.ts. Das Zahnrad steht nur für Einstellungen (B4).
    children: [
      {
        text: 'Benutzer und Rechte', icon: 'user-settings',
        children: [
          { text: 'Benutzer', icon: 'group', path: '/admin/benutzer', permission: 'core.users:display' },
          { text: 'Rollen', icon: 'role', path: '/admin/rollen', permission: 'core.roles:display' },
          { text: 'Rollenmatrix', icon: 'grid', path: '/admin/rollenmatrix', permission: 'core.roles:display' },
        ],
      },
      {
        text: 'Einstellungen', icon: 'action-settings',
        children: [
          { text: 'Einstellungen', icon: 'action-settings', path: '/admin/einstellungen', permission: 'core.settings:edit' },
          { text: 'Funktionen', icon: 'activate', path: '/admin/funktionen', permission: 'core.funktionen:edit' },
        ],
      },
      {
        text: 'Schnittstellen', icon: 'connected',
        children: [
          // eine App, ein Reiter je Schnittstelle (#232, S1) – Anbindungen, Paperless-Zuordnung und API-Schlüssel sind darin aufgegangen
          { text: 'Schnittstellen', icon: 'connected', path: '/admin/schnittstellen', permission: 'core.settings:edit|core.apikeys:display' },
        ],
      },
      {
        text: 'Protokolle', icon: 'history',
        children: [
          { text: 'Änderungsbelege', icon: 'history', path: '/admin/aenderungsbelege', permission: 'core.audit:display' },
          { text: 'E-Mail-Protokoll', icon: 'email', path: '/admin/mailprotokoll', permission: 'core.mail:display' },
          { text: 'Statistik', icon: 'line-chart', path: '/admin/statistik', permission: 'core.statistik:display' },
        ],
      },
      {
        text: 'System', icon: 'it-system',
        children: [
          { text: 'Sicherung', icon: 'shield', path: '/admin/sicherung', permission: 'core.backup:create' },
          { text: 'Sperren', icon: 'locked', path: '/admin/sperren', permission: 'core.sperren:admin' },
          { text: 'Tabellenansicht', icon: 'table-view', path: '/admin/tabellen', permission: 'core.tabellen:display' },
        ],
      },
    ],
  },
};

export const coreRoutes: RouteDef[] = [
  { path: '/', component: HomePage },
  { path: '/admin/benutzer', component: UsersPage, permission: 'core.users:display' },
  { path: '/admin/rollen', component: RolesPage, permission: 'core.roles:display' },
  { path: '/admin/rollenmatrix', component: RollenmatrixPage, permission: 'core.roles:display' },
  { path: '/admin/api-schluessel', component: ZuApiSchluessel, permission: 'core.apikeys:display' },
  { path: '/admin/aenderungsbelege', component: AuditPage, permission: 'core.audit:display' },
  { path: '/admin/mailprotokoll', component: MailProtokollPage, permission: 'core.mail:display' },
  // ohne eigenes Recht: Die App zeigt die Kapitel, die der Benutzer sehen darf (#232, E1 – web/src/einstellungen.ts)
  { path: '/admin/einstellungen', component: EinstellungenPage },
  { path: '/admin/funktionen', component: FunktionenPage, permission: 'core.funktionen:edit' },
  // App „Schnittstellen“ (#232, S1); die bisherigen Adressen springen in den passenden Reiter
  // ohne eigenes Recht: Die App zeigt die Reiter, die der Benutzer sehen darf (web/src/schnittstellen.ts)
  { path: '/admin/schnittstellen', component: SchnittstellenPage },
  { path: '/admin/anbindungen', component: ZuAnbindungen, permission: 'core.settings:edit' },
  { path: '/admin/paperless', component: ZuPaperlessZuordnung, permission: 'core.settings:edit' },
  { path: '/admin/sperren', component: SperrenPage, permission: 'core.sperren:admin' },
  { path: '/admin/sicherung', component: BackupPage, permission: 'core.backup:create' },
  { path: '/admin/statistik', component: StatistikPage, permission: 'core.statistik:display' },
  { path: '/admin/tabellen', component: TabellenPage, permission: 'core.tabellen:display' },
];
