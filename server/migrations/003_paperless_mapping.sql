-- Zentrale Paperless-Zuordnung: je Modul und Ablagekontext eine Regel (Vorlagen für Titel,
-- Korrespondent, Dokumenttyp, Speicherpfad, Tags, Datum, Notiz und Custom Fields).
-- Nicht gespeicherte Kontexte nutzen die Standardregel des Moduls.
create table if not exists core.paperless_mapping (
  modul        text        not null,
  kontext      text        not null,
  regel        jsonb       not null,
  geaendert_am timestamptz not null default now(),
  geaendert_von text,
  primary key (modul, kontext)
);
select core.enable_audit('core.paperless_mapping', 'PAPERLESS_MAPPING', 'modul,kontext');
