-- ============================================================================
-- Kern-Schema der Portalbasis
--   Benutzer, Sitzungen, Rollen, Berechtigungen, Einstellungen,
--   Nummernkreise und generische Änderungsbelege (wie CDHDR/CDPOS).
-- ============================================================================

create extension if not exists pgcrypto;
create schema if not exists core;

-- ---------------------------------------------------------------------------
-- Hilfsfunktion: updated_at automatisch pflegen
-- ---------------------------------------------------------------------------
create or replace function core.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Änderungsbelege
-- ---------------------------------------------------------------------------
create table core.change_header (
  id           bigserial primary key,
  object_type  text        not null,           -- z. B. USER, ROLE, KONTAKT, AUFTRAG
  object_key   text        not null,           -- fachlicher Schlüssel des Objekts
  table_name   text        not null,
  change_ind   char(1)     not null check (change_ind in ('I','U','D')),
  action       text,                           -- fachliche Aktion, z. B. STORNO
  reason       text,                           -- Begründung
  user_id      uuid,
  username     text        not null,
  tx_id        bigint      not null,
  changed_at   timestamptz not null default now()
);
create index change_header_obj_idx  on core.change_header (object_type, object_key, changed_at desc);
create index change_header_user_idx on core.change_header (username, changed_at desc);
create index change_header_time_idx on core.change_header (changed_at desc);

create table core.change_item (
  id         bigserial primary key,
  header_id  bigint not null references core.change_header(id) on delete cascade,
  field      text   not null,
  old_value  text,
  new_value  text
);
create index change_item_header_idx on core.change_item (header_id);

-- Änderungsbelege sind unveränderlich. Löschen nur für die bewusste
-- Bereinigung nach Ablauf der Aufbewahrungsfrist (app.allow_audit_purge = on).
create or replace function core.protect_change_docs() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.allow_audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'Änderungsbelege dürfen nicht verändert oder gelöscht werden';
end $$;

create trigger protect_change_header before update or delete on core.change_header
  for each row execute function core.protect_change_docs();
create trigger protect_change_item before update or delete on core.change_item
  for each row execute function core.protect_change_docs();

-- Generischer Trigger. Argumente:
--   0 = Objekttyp, 1 = Schlüsselspalten (kommagetrennt),
--   2 = maskierte Felder (Wert wird als *** protokolliert),
--   3 = ignorierte Felder (werden nicht protokolliert)
create or replace function core.audit_trigger() returns trigger
language plpgsql as $$
declare
  v_obj_type text   := tg_argv[0];
  v_key_cols text[] := string_to_array(tg_argv[1], ',');
  v_masked   text[] := coalesce(string_to_array(nullif(tg_argv[2], ''), ','), '{}');
  v_ignore   text[] := coalesce(string_to_array(nullif(tg_argv[3], ''), ','), '{}');
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_ind char(1);
  v_key text;
  v_hdr bigint;
  v_fields text[] := '{}';
  k text;
  o text;
  n text;
begin
  if tg_op = 'INSERT' then
    v_ind := 'I'; v_new := to_jsonb(new); v_row := v_new;
  elsif tg_op = 'UPDATE' then
    v_ind := 'U'; v_old := to_jsonb(old); v_new := to_jsonb(new); v_row := v_new;
  else
    v_ind := 'D'; v_old := to_jsonb(old); v_row := v_old;
  end if;

  for k in select jsonb_object_keys(v_row) loop
    continue when k = any(v_ignore);
    o := v_old ->> k;
    n := v_new ->> k;
    if v_ind = 'U' and o is not distinct from n then continue; end if;
    if v_ind = 'I' and n is null then continue; end if;
    if v_ind = 'D' and o is null then continue; end if;
    v_fields := v_fields || k;
  end loop;

  -- reine Technik-Änderungen (z. B. nur updated_at) erzeugen keinen Beleg
  if v_ind = 'U' and cardinality(v_fields) = 0 then
    return new;
  end if;

  select string_agg(v_row ->> c, '/' order by ord)
    into v_key
    from unnest(v_key_cols) with ordinality as t(c, ord);

  insert into core.change_header
    (object_type, object_key, table_name, change_ind, action, reason, user_id, username, tx_id)
  values
    (v_obj_type, coalesce(v_key, '?'), tg_table_schema || '.' || tg_table_name, v_ind,
     nullif(current_setting('app.action', true), ''),
     nullif(current_setting('app.reason', true), ''),
     nullif(current_setting('app.user_id', true), '')::uuid,
     coalesce(nullif(current_setting('app.username', true), ''), session_user),
     txid_current())
  returning id into v_hdr;

  foreach k in array v_fields loop
    o := v_old ->> k;
    n := v_new ->> k;
    if k = any(v_masked) then
      o := case when o is null then null else '***' end;
      n := case when n is null then null else '***' end;
    end if;
    insert into core.change_item (header_id, field, old_value, new_value)
    values (v_hdr, k, o, n);
  end loop;

  return coalesce(new, old);
end $$;

-- Änderungsbelege für eine Tabelle einschalten
create or replace function core.enable_audit(
  p_table regclass,
  p_object_type text,
  p_key_cols text,
  p_masked text default '',
  p_ignore text default 'created_at,updated_at'
) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists zz_audit on %s', p_table);
  execute format(
    'create trigger zz_audit after insert or update or delete on %s
       for each row execute function core.audit_trigger(%L, %L, %L, %L)',
    p_table, p_object_type, p_key_cols, p_masked, p_ignore);
end $$;

-- ---------------------------------------------------------------------------
-- Einstellungen (Schlüssel/Wert)
-- ---------------------------------------------------------------------------
create table core.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
create trigger settings_touch before update on core.settings
  for each row execute function core.touch_updated_at();
select core.enable_audit('core.settings', 'SETTING', 'key');

-- ---------------------------------------------------------------------------
-- Benutzer, Sitzungen
-- ---------------------------------------------------------------------------
create table core.users (
  id                   uuid primary key default gen_random_uuid(),
  username             text not null,
  display_name         text not null,
  email                text,
  password_hash        text not null,
  active               boolean not null default true,
  must_change_password boolean not null default false,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index users_username_uq on core.users (lower(username));
create trigger users_touch before update on core.users
  for each row execute function core.touch_updated_at();
select core.enable_audit('core.users', 'USER', 'username', 'password_hash',
                         'id,created_at,updated_at,last_login_at');

create table core.sessions (
  token_hash  text primary key,               -- sha256 des Cookie-Tokens
  user_id     uuid not null references core.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  ip          text,
  user_agent  text
);
create index sessions_user_idx on core.sessions (user_id);

-- ---------------------------------------------------------------------------
-- Rollen und Berechtigungen
--   Berechtigung = "<objekt>:<aktivität>", z. B. "core.users:edit".
--   "*" = alle Berechtigungen (Administrator).
-- ---------------------------------------------------------------------------
create table core.roles (
  id          text primary key,               -- z. B. ADMIN, KASSENWART, DISPONENT
  name        text not null,
  description text,
  system      boolean not null default false, -- Systemrollen nicht löschbar
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger roles_touch before update on core.roles
  for each row execute function core.touch_updated_at();
select core.enable_audit('core.roles', 'ROLE', 'id');

create table core.role_permissions (
  role_id    text not null references core.roles(id) on delete cascade,
  permission text not null,
  primary key (role_id, permission)
);
select core.enable_audit('core.role_permissions', 'ROLE', 'role_id');

create table core.user_roles (
  user_id uuid not null references core.users(id) on delete cascade,
  role_id text not null references core.roles(id) on delete cascade,
  primary key (user_id, role_id)
);
select core.enable_audit('core.user_roles', 'USER_ROLE', 'user_id');

insert into core.roles (id, name, description, system)
values ('ADMIN', 'Administrator', 'Alle Berechtigungen', true);
insert into core.role_permissions (role_id, permission) values ('ADMIN', '*');

-- ---------------------------------------------------------------------------
-- Nummernkreise (lückenlos, z. B. Belegnummern, Auftragsnummern)
-- ---------------------------------------------------------------------------
create table core.number_ranges (
  id         text    not null,                -- z. B. FI_BELEG, AUFTRAG
  year       integer not null default 0,      -- 0 = jahresunabhängig
  prefix     text    not null default '',
  last_value bigint  not null default 0,
  primary key (id, year)
);
-- bewusst ohne Änderungsbeleg: jede Nummernvergabe wäre sonst ein Beleg

-- Vergibt die nächste Nummer innerhalb der laufenden Transaktion.
-- Wird die Transaktion zurückgerollt, wird auch die Nummer nicht verbraucht.
create or replace function core.next_number(p_id text, p_year integer default 0)
returns bigint
language plpgsql as $$
declare
  v bigint;
begin
  insert into core.number_ranges (id, year) values (p_id, p_year)
    on conflict (id, year) do nothing;
  update core.number_ranges
     set last_value = last_value + 1
   where id = p_id and year = p_year
  returning last_value into v;
  return v;
end $$;
