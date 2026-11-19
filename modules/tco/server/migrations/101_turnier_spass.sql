-- Spaßturnier: Pausenwunsch für die nächste (noch nicht ausgeloste) Runde je Teilnehmer.
-- Gesetzt von der Turnierleitung oder über den persönlichen Link; beim Auslosen in tco.turnier_einteilung.pause_gewuenscht
-- übernommen und zurückgesetzt (wird eine noch nicht gestartete Runde gelöscht, lebt der Wunsch wieder auf).
alter table tco.turnier_teilnehmer add column pause_naechste boolean not null default false;
