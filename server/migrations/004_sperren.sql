-- Sperren gegen gleichzeitige Bearbeitung (vergleichbar SAP-Sperreinträge, SM12).
--
-- Die Oberfläche setzt beim Öffnen eines Objekts zur Bearbeitung eine Sperre (Objekttyp + Schlüssel wie in den
-- Änderungsbelegen) und hält sie per Lebenszeichen aktiv; ohne Lebenszeichen läuft sie nach kurzer Zeit ab.
-- Optional mit Zeitraum (von/bis), z. B. für eine ausgewählte, noch nicht gesicherte Platzbuchung.
--
-- Durchsetzung in der Datenbank: Der generische Änderungsbeleg-Trigger prüft bei jeder Änderung aus der Oberfläche
-- (app.sitzung gesetzt), ob eine ANDERE Sitzung das Objekt gesperrt hat, und bricht die Transaktion dann ab.
create table if not exists core.sperren (
  id          bigserial primary key,
  objekt      text        not null,               -- Objekttyp, z. B. MITGLIED, AUFTRAG, PLATZZEIT
  schluessel  text        not null,               -- Objektschlüssel, '*' = alle Objekte des Typs
  objekte     text[]      not null,               -- mitgesperrte Objekttypen (objekt + Verbund)
  von         timestamp,                          -- optionaler Zeitraum (Ortszeit)
  bis         timestamp,
  sitzung     text        not null,               -- Hash des Sitzungs-Tokens
  benutzer_id uuid,
  benutzer    text        not null,
  bezeichnung text,
  erstellt    timestamptz not null default now(),
  ablauf      timestamptz not null
);
create index if not exists sperren_objekt_idx on core.sperren (objekt, schluessel);
create index if not exists sperren_sitzung_idx on core.sperren (sitzung);
-- bewusst ohne Änderungsbeleg (flüchtig)

create or replace function core.sperre_pruefen(p_typ text, p_key text) returns void
language plpgsql as $$
declare
  v_sitz text := nullif(current_setting('app.sitzung', true), '');
  s record;
begin
  if v_sitz is null then return; end if;
  select * into s from core.sperren
   where p_typ = any(objekte) and von is null and ablauf > now() and sitzung <> v_sitz
     and (schluessel = '*' or schluessel = p_key or left(p_key, length(schluessel) + 1) = schluessel || '/')
   order by erstellt limit 1;
  if found then
    raise exception using errcode = 'LK423',
      message = replace(format('%s %s wird gerade von %s bearbeitet (gesperrt seit %s Uhr). Die Änderung wurde nicht gespeichert – bitte später erneut versuchen.',
                       coalesce(s.bezeichnung, p_typ), case when s.schluessel = '*' then '' else p_key end, s.benutzer,
                       to_char(s.erstellt at time zone 'Europe/Berlin', 'HH24:MI')), '  ', ' ');
  end if;
end $$;

-- Änderungsbeleg-Trigger mit Sperrprüfung (sonst unverändert)
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

  -- Sperre eines anderen Benutzers/einer anderen Sitzung? (nur bei Änderungen aus der Oberfläche)
  perform core.sperre_pruefen(v_obj_type, coalesce(v_key, '?'));

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
