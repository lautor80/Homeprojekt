-- Funktionsschalter (#232, F1): Anwendungen, Bereiche, Apps und einzelne Funktionen lassen sich vom Administrator
-- abschalten (Administration → Einstellungen → Funktionen). Eine Zeile gibt es erst, wenn ein Schalter einmal betätigt
-- wurde; ohne Zeile ist die Funktion an. Die Ids stammen aus dem Verzeichnis (server/src/lib/funktionen.ts):
--   m:<modul>           Anwendung            b:<modul>:<Bereich>   Bereich
--   a:<modul>:<App>     App                  <modul>.<name>         einzelne Funktion (vom Modul angemeldet)
create table if not exists core.funktionen (
  id            text primary key,
  aktiv         boolean not null default true,
  geaendert_am  timestamptz not null default now(),
  geaendert_von text not null default ''
);
comment on table core.funktionen is 'Funktionsschalter: abgeschaltete Anwendungen, Bereiche, Apps und Funktionen (aktiv = false)';
select core.enable_audit('core.funktionen', 'FUNKTION', 'id', '', 'geaendert_am');
