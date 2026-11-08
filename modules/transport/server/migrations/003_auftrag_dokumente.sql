-- Dokumente zum Auftrag (Paperless): unterschriebene Lieferscheine, CMR, Fotos, Rechnungen von Subunternehmern …
-- Die Datei liegt in Paperless; hier steht nur die Verknüpfung Auftrag ↔ Dokument.
create table if not exists transport.auftrag_dokumente (
  auftragsnr  text        not null references transport.auftraege(auftragsnr) on delete cascade,
  doc_id      integer     not null,
  titel       text,
  datei       text,
  erstellt_am timestamptz not null default now(),
  erstellt_von text,
  primary key (auftragsnr, doc_id)
);
select core.enable_audit('transport.auftrag_dokumente', 'AUFTRAG', 'auftragsnr');
