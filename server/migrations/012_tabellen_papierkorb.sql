-- Tabellenansicht (#34): gelöschte Datensätze für die kurzfristige Wiederherstellung. Je Satz die vollständige Zeile als JSON,
-- der Primärschlüssel und wer wann gelöscht hat; ein Löschvorgang (mehrere Sätze) hat eine gemeinsame Vorgangsnummer.
-- Einträge verfallen nach 7 Tagen (Aufräumen bei jedem Zugriff), wiederhergestellte Sätze werden sofort entfernt.
create table if not exists core.tabellen_papierkorb (
  id             bigserial primary key,
  vorgang        uuid not null,
  schema_name    text not null,
  tabelle        text not null,
  schluessel     jsonb not null,                    -- Primärschlüssel des Satzes {spalte: wert}
  zeile          jsonb not null,                    -- vollständiger Satz (auch Geheimnisse – in der Tabellenansicht maskiert)
  geloescht_am   timestamptz not null default now(),
  geloescht_von  text not null,
  grund          text
);
create index if not exists tabellen_papierkorb_zeit_idx on core.tabellen_papierkorb (geloescht_am);
comment on table core.tabellen_papierkorb is 'Tabellenansicht: gelöschte Datensätze zur Wiederherstellung (7 Tage)';
