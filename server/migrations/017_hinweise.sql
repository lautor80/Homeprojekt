-- Hinweise im Arbeitsvorrat (#232, V1): Ereignisse, die sich nicht aus dem aktuellen Stand berechnen lassen – ein Mitglied
-- ändert seine Bankverbindung, eine Schnittstelle scheitert, ein Lauf sperrt einen Benutzer. Die Stelle, an der das Ereignis
-- geschieht, meldet es (server/src/lib/hinweise.ts, hinweisMelden); im Arbeitsvorrat steht es, bis jemand mit dem Recht
-- der zugehörigen App „gesehen“ bestätigt oder die Störung behoben ist (hinweisBeheben).
--   modul    Anwendung, in deren Block der Hinweis steht (core, tco, transport)
--   quelle   Art des Ereignisses, z. B. MG_BANK; objekt: worum es geht (Mitgliedsnummer …)
--   Je Quelle und Objekt gibt es höchstens einen offenen Hinweis – Wiederholungen zählen ihn hoch.
create table if not exists core.hinweise (
  id           bigserial primary key,
  modul        text not null,
  quelle       text not null,
  objekt       text not null default '',
  bereich      text not null,
  recht        text not null,
  art          text not null,
  titel        text not null,
  text         text not null default '',
  icon         text not null default 'message-information',
  state        text not null default 'Information' check (state in ('Information', 'Critical', 'Negative')),
  pfad         text not null,
  anzahl       integer not null default 1,
  erstellt_am  timestamptz not null default now(),
  zuletzt_am   timestamptz not null default now(),
  erledigt_am  timestamptz,
  erledigt_von text
);
comment on table core.hinweise is 'Arbeitsvorrat: gemeldete Ereignisse (Hinweise), offen bis „gesehen“ oder behoben';
create unique index if not exists hinweise_offen_idx on core.hinweise (modul, quelle, objekt) where erledigt_am is null;
create index if not exists hinweise_erledigt_idx on core.hinweise (erledigt_am);
