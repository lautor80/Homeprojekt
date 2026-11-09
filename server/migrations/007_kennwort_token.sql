-- Einmal-Links zum Festlegen bzw. Zurücksetzen des Kennworts („Passwort vergessen“, Anlage ohne Startkennwort).
-- Gespeichert wird nur der SHA-256-Hash des Tokens; ein Link gilt einmal und läuft ab.
create table if not exists core.password_tokens (
  id          bigserial primary key,
  user_id     uuid not null references core.users(id) on delete cascade,
  zweck       text not null check (zweck in ('RESET', 'SETZEN')),
  token_hash  text not null unique,
  gueltig_bis timestamptz not null,
  verwendet_am timestamptz,
  erstellt    timestamptz not null default now(),
  ip          text
);
create index if not exists password_tokens_user_idx on core.password_tokens (user_id, zweck);
