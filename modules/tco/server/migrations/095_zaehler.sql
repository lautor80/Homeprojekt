-- Zählerstände (Bereich Instandhaltung): Zähler für Strom, Gas, Wasser, Wärme, PV-Erzeugung, Heizöl … und ihre Ablesungen.
-- Der Verbrauch wird nicht gespeichert, sondern aus den Ständen berechnet (modules/tco/server/zaehler/logik.ts):
-- Differenz zweier aufeinanderfolgender Stände × Faktor, bei Überlauf des Zählwerks über die Stellenzahl, beim
-- Zählerwechsel (Ausbau des alten, Einbau des neuen Zählers) ohne Verbrauch zwischen Ausbau und Einbau.
create table if not exists tco.zaehler (
  id               serial primary key,
  nummer           text not null unique,                     -- fortlaufend aus dem Nummernkreis ZAEHLER, z. B. Z0001
  bezeichnung      text not null,
  medium           text not null check (medium in ('STROM', 'GAS', 'WASSER', 'WAERME', 'PV', 'OEL', 'SONSTIGES')),
  einheit          text not null default '',                 -- Einheit des Zählwerks (kWh, m³, l …)
  standort         text,
  zaehlernummer    text,                                     -- Herstell-/Zählernummer auf dem Gerät
  faktor           numeric(14,6) not null default 1 check (faktor > 0),   -- Wandlerfaktor bzw. m³ → kWh
  verbrauchseinheit text,                                    -- Einheit nach dem Faktor; leer = wie einheit
  stellen          int check (stellen between 1 and 12),     -- Vorkommastellen des Zählwerks (Überlauf); leer = kein Überlauf
  intervall_tage   int check (intervall_tage between 1 and 3660),  -- Ableseintervall (Erinnerung im Arbeitsvorrat)
  arbeitspreis     numeric(12,5),                            -- € je Verbrauchseinheit (brutto)
  grundpreis_monat numeric(12,2),                            -- € je Monat (brutto)
  jahresziel       numeric(16,3),                            -- Zielwert Verbrauch je Kalenderjahr
  aktiv            boolean not null default true,
  notiz            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
drop trigger if exists zaehler_touch on tco.zaehler;
create trigger zaehler_touch before update on tco.zaehler for each row execute function core.touch_updated_at();
select core.enable_audit('tco.zaehler', 'ZAEHLER', 'nummer');

create table if not exists tco.zaehlerstand (
  id          serial primary key,
  zaehler_id  int not null references tco.zaehler(id) on delete restrict,
  datum       date not null,
  stand       numeric(14,3) not null,
  -- ABLESUNG, SCHAETZUNG; Zählerwechsel: AUSBAU = Endstand des alten, EINBAU = Anfangsstand des neuen Zählers
  art         text not null default 'ABLESUNG' check (art in ('ABLESUNG', 'SCHAETZUNG', 'AUSBAU', 'EINBAU')),
  notiz       text,
  foto        bytea,                                         -- Foto des Zählwerks (optional)
  foto_typ    text,                                          -- image/jpeg, image/png, image/webp
  erfasst_von uuid references core.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (zaehler_id, datum, art)
);
create index if not exists zaehlerstand_idx on tco.zaehlerstand (zaehler_id, datum);
-- das Foto selbst gehört nicht in den Änderungsbeleg (nur „geändert“)
select core.enable_audit('tco.zaehlerstand', 'ZAEHLERSTAND', 'zaehler_id,id', 'foto');

-- Nummernkreis der Zähler (jahresunabhängig, Präfix Z)
insert into core.number_ranges (id, year, prefix) values ('ZAEHLER', 0, 'Z') on conflict do nothing;

-- Wer heute die Stammdaten der Instandhaltung pflegt, bekommt auch die Zählerstände (in der Rollenpflege änderbar)
insert into core.role_permissions (role_id, permission)
select role_id, p.permission from core.role_permissions
 cross join (values ('tco.zaehler:display'), ('tco.zaehler:edit'), ('tco.zaehler:admin')) as p(permission)
 where core.role_permissions.permission = 'tco.instandhaltung:admin'
on conflict do nothing;
