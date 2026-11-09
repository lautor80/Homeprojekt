-- Nutzungsstatistik (Administration → Statistik): Anmeldungen und Aufrufe der Apps.
create table if not exists core.nutzung (
  id       bigserial primary key,
  zeit     timestamptz not null default now(),
  user_id  uuid references core.users(id) on delete set null,
  art      text not null check (art in ('LOGIN', 'APP')),
  pfad     text                                        -- Route der App (z. B. /tco/halle), bei LOGIN leer
);
create index if not exists nutzung_zeit_idx on core.nutzung (zeit);
create index if not exists nutzung_art_zeit_idx on core.nutzung (art, zeit);
