-- Dokumenten-Upload: Uploads mit Folgeaktion merken, damit sie im Arbeitsvorrat erscheinen (z. B. „Überweisung an Einreicher“ beim Kassenwart).
-- Das Dokument selbst liegt nur in Paperless.
create table if not exists tco.upload_folge (
  id           serial primary key,
  dok_id       int,
  titel        text not null,
  datei        text,
  folgeaktion  text not null,
  einreicher   text not null,
  am           timestamptz not null default now(),
  erledigt_am  timestamptz,
  erledigt_von text
);
select core.enable_audit('tco.upload_folge', 'UPLOAD', 'id');
