-- Ansichtsvarianten je Benutzer für alle Apps mit Tabellen: gespeicherte Auswahl (Filter, Suche, Sortierung, Zeitraum …)
-- unter einem Namen, optional als Standard (wird beim Öffnen der App geladen) oder für alle Benutzer (uname = '*').
create table if not exists core.varianten (
  repid       text not null,                       -- App bzw. Liste, z. B. 'tco.konten'
  uname       text not null,                       -- Benutzername oder '*' (für alle)
  name        text not null,
  standard    boolean not null default false,
  inhalt      jsonb not null default '{}',
  geaendert   timestamptz not null default now(),
  primary key (repid, uname, name)
);
comment on table core.varianten is 'Ansichtsvarianten der Apps (Filter, Suche, Sortierung) je Benutzer oder für alle';
