-- Rundschreiben: E-Mails an alle Mitglieder oder an Mitgliedergruppen aus dem Portal, mit Versandprotokoll.
-- Ein Rundschreiben ist zuerst ein Entwurf (Betreff, Text mit Platzhaltern, Anhänge, Empfängerauswahl). Mit dem Senden
-- wird die Empfängerliste festgeschrieben (eine Zeile je E-Mail-Adresse bzw. je Person ohne Adresse); der Versand läuft
-- danach im Hintergrund Zeile für Zeile – der Status je Zeile verhindert den Doppelversand, auch nach einem Neustart.
create table if not exists tco.rundschreiben (
  id            serial primary key,
  betreff       text not null default '',
  text          text not null default '',
  antwort_an    text,                               -- Antwortadresse (Reply-To); leer = der Absender
  auswahl       jsonb not null default '{}',        -- { alle, gruppen[], alter, arten[], dazu[], ohne[] }
  status        text not null default 'ENTWURF' check (status in ('ENTWURF', 'VERSAND', 'ANGEHALTEN', 'FERTIG')),
  hinweis       text,                               -- warum der Versand angehalten wurde
  kopie_von     int,                                -- als Vorlage kopiert aus diesem Rundschreiben
  erstellt_am   timestamptz not null default now(),
  erstellt_von  text,
  geaendert_am  timestamptz not null default now(),
  geaendert_von text,
  gesendet_am   timestamptz,                        -- Versand ausgelöst
  gesendet_von  text,
  absender      text,                               -- E-Mail-Adresse dessen, der den Versand ausgelöst hat (leer = Ersatzabsender)
  absender_name text,
  fertig_am     timestamptz,
  paperless_id  int,
  paperless_am  timestamptz
);
select core.enable_audit('tco.rundschreiben', 'RUNDSCHREIBEN', 'id', '', 'geaendert_am,geaendert_von,fertig_am,paperless_am');

create table if not exists tco.rundschreiben_anhaenge (
  id               serial primary key,
  rundschreiben_id int not null references tco.rundschreiben(id) on delete cascade,
  dateiname        text not null,
  mime             text not null,
  groesse          int not null,
  inhalt           bytea not null
);
create index if not exists rundschreiben_anhaenge_idx on tco.rundschreiben_anhaenge (rundschreiben_id, id);

-- Eine Zeile je E-Mail-Adresse (Familien mit gemeinsamer Adresse: eine Zeile mit mehreren Personen) bzw. je Person
-- ohne E-Mail-Adresse. SENDET = gerade in Arbeit; bleibt eine Zeile nach einem Abbruch so stehen, ist ungewiss, ob die
-- E-Mail hinausging – sie wird dann als Fehler gezeigt und nicht von selbst wiederholt.
create table if not exists tco.rundschreiben_empfaenger (
  id               bigserial primary key,
  rundschreiben_id int not null references tco.rundschreiben(id) on delete cascade,
  email            text,                            -- null = ohne E-Mail-Adresse
  adrnrs           text[] not null,                 -- Personen, für die diese E-Mail bestimmt ist
  namen            text not null,
  anrede           text not null default '',
  vorname          text not null default '',
  nachname         text not null default '',
  weg              text not null default '',        -- woher die Adresse stammt (EIGEN, ZAHLER, KONTOINHABER, FAMILIE)
  status           text not null default 'OFFEN' check (status in ('OFFEN', 'SENDET', 'GESENDET', 'FEHLER', 'OHNE_MAIL')),
  fehler           text,
  versuche         int not null default 0,
  begonnen_am      timestamptz,
  gesendet_am      timestamptz
);
create index if not exists rundschreiben_empfaenger_idx on tco.rundschreiben_empfaenger (rundschreiben_id, status, id);
-- je Rundschreiben und E-Mail-Adresse höchstens eine Zeile – also höchstens eine E-Mail
create unique index if not exists rundschreiben_empfaenger_adresse_uq
  on tco.rundschreiben_empfaenger (rundschreiben_id, lower(email)) where email is not null;
