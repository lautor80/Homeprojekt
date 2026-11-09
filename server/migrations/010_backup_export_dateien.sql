-- Nextcloud-Export: zusätzlich zur Übertragung als eine Datei (.portal bzw. ZIP mit XML) die dateiweise
-- Übertragung ohne ZIP (format = 'dateien'): je Lauf ein Ordner mit manifest.xml und je Tabelle einer XML-Datei.
alter table core.backup_export drop constraint if exists backup_export_format_check;
alter table core.backup_export add constraint backup_export_format_check check (format in ('portal', 'zip', 'dateien'));
