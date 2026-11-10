import type { NavEntry, RouteDef } from '../platform';
import { HomePage } from '../pages/HomePage';
import { UsersPage } from '../pages/UsersPage';
import { RolesPage } from '../pages/RolesPage';
import { AuditPage } from '../pages/AuditPage';
import { SettingsPage } from '../pages/SettingsPage';
import { PaperlessMappingPage } from '../pages/PaperlessMappingPage';
import { VerbindungenPage } from '../pages/VerbindungenPage';
import { BackupPage } from '../pages/BackupPage';
import { StatistikPage } from '../pages/StatistikPage';
import { ApiKeysPage } from '../pages/ApiKeysPage';
import { SperrenPage } from '../pages/SperrenPage';
import { TabellenPage } from '../pages/TabellenPage';
import { MailProtokollPage } from '../pages/MailProtokollPage';

export const coreNav: { home: NavEntry; admin: NavEntry } = {
  home: { text: 'Start', icon: 'home', path: '/' },
  admin: {
    text: 'Administration',
    einruecken: true,
    children: [
      { text: 'Benutzer', icon: 'group', path: '/admin/benutzer', permission: 'core.users:display' },
      { text: 'Rollen', icon: 'role', path: '/admin/rollen', permission: 'core.roles:display' },
      { text: 'API-Schlüssel', icon: 'key', path: '/admin/api-schluessel', permission: 'core.apikeys:display' },
      { text: 'Änderungsbelege', icon: 'history', path: '/admin/aenderungsbelege', permission: 'core.audit:display' },
      { text: 'E-Mail-Protokoll', icon: 'email', path: '/admin/mailprotokoll', permission: 'core.mail:display' },
      { text: 'Einstellungen', icon: 'action-settings', path: '/admin/einstellungen', permission: 'core.settings:edit' },
      { text: 'Anbindungen', icon: 'connected', path: '/admin/anbindungen', permission: 'core.settings:edit' },
      { text: 'Paperless-Zuordnung', icon: 'attachment', path: '/admin/paperless', permission: 'core.settings:edit' },
      { text: 'Sperren', icon: 'locked', path: '/admin/sperren', permission: 'core.sperren:admin' },
      { text: 'Sicherung', icon: 'database', path: '/admin/sicherung', permission: 'core.backup:create' },
      { text: 'Statistik', icon: 'line-chart', path: '/admin/statistik', permission: 'core.statistik:display' },
      { text: 'Tabellenansicht', icon: 'table-view', path: '/admin/tabellen', permission: 'core.tabellen:display' },
    ],
  },
};

export const coreRoutes: RouteDef[] = [
  { path: '/', component: HomePage },
  { path: '/admin/benutzer', component: UsersPage, permission: 'core.users:display' },
  { path: '/admin/rollen', component: RolesPage, permission: 'core.roles:display' },
  { path: '/admin/api-schluessel', component: ApiKeysPage, permission: 'core.apikeys:display' },
  { path: '/admin/aenderungsbelege', component: AuditPage, permission: 'core.audit:display' },
  { path: '/admin/mailprotokoll', component: MailProtokollPage, permission: 'core.mail:display' },
  { path: '/admin/einstellungen', component: SettingsPage, permission: 'core.settings:edit' },
  { path: '/admin/anbindungen', component: VerbindungenPage, permission: 'core.settings:edit' },
  { path: '/admin/paperless', component: PaperlessMappingPage, permission: 'core.settings:edit' },
  { path: '/admin/sperren', component: SperrenPage, permission: 'core.sperren:admin' },
  { path: '/admin/sicherung', component: BackupPage, permission: 'core.backup:create' },
  { path: '/admin/statistik', component: StatistikPage, permission: 'core.statistik:display' },
  { path: '/admin/tabellen', component: TabellenPage, permission: 'core.tabellen:display' },
];
