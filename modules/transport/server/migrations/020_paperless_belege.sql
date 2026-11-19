-- Belege, die beim Drucken und Versenden automatisch in Paperless abgelegt wurden (Transportauftrag T, Lieferschein L,
-- Rechnung R). Je Beleg der Änderungsstand der Aufträge bei der letzten Ablage – erneut abgelegt wird nur nach einer Änderung.
create table if not exists transport.paperless_belege (
  art          text        not null check (art in ('T', 'L', 'R')),
  kennung      text        not null,             -- Auftragsnummer, „Auftrag-Fahrt“ oder Rechnungsnummer
  stand        timestamptz not null,             -- jüngste Änderung der Aufträge beim Ablegen
  doc_id       integer,                          -- Paperless-Dokument (leer, solange Paperless noch verarbeitet)
  anlass       text        not null check (anlass in ('druck', 'versand')),
  abgelegt_am  timestamptz not null default now(),
  abgelegt_von text,
  primary key (art, kennung)
);
