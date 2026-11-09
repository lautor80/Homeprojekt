-- n8n-Webhooks der Importe (EP3, Rückmeldungen, Ferien) in die zentralen Anbindungen tco.ep3 / tco.stunden / tco.ferien
-- (Administration → Anbindungen). Der bisherige Authorization-Header (Basic …) wird in Benutzer/Passwort zerlegt; ein anders
-- gearteter Header wird als eigener Header „Authorization“ übernommen. Alte Spalten bleiben leer stehen.
create or replace function pg_temp.basic_teil(p_auth text, p_teil int) returns text language sql immutable as $$
  select case when p_auth ~ '^Basic ' then split_part(convert_from(decode(substr(p_auth, 7), 'base64'), 'UTF8'), ':', p_teil) end
$$;
insert into core.verbindungen (id, url, auth_art, auth_user, header_name, geheimnis, geaendert_von)
select w.id, w.url, case when w.auth is null then 'keine' when w.auth ~ '^Basic ' then 'basic' else 'header' end,
       case when w.auth ~ '^Basic ' then coalesce(nullif(pg_temp.basic_teil(w.auth, 1), ''), w.user_alt) end,
       case when w.auth is not null and w.auth !~ '^Basic ' then 'Authorization' end,
       case when w.auth ~ '^Basic ' then nullif(pg_temp.basic_teil(w.auth, 2), '') else w.auth end, 'Migration tco'
  from (
    select 'tco.ep3' as id, v.n8n_ep3_url as url, v.n8n_ep3_auth as auth, v.n8n_ep3_user as user_alt from tco.verein v where v.id = 1
    union all select 'tco.stunden', v.n8n_stunden_url, v.n8n_stunden_auth, v.n8n_stunden_user from tco.verein v where v.id = 1
    union all select 'tco.ferien', v.n8n_ferien_url, v.n8n_stunden_auth, v.n8n_stunden_user from tco.verein v where v.id = 1
  ) w
 where coalesce(w.url, '') <> ''
on conflict (id) do update set url = excluded.url, auth_art = excluded.auth_art, auth_user = excluded.auth_user, header_name = excluded.header_name,
  geheimnis = coalesce(excluded.geheimnis, core.verbindungen.geheimnis), geaendert_am = now(), geaendert_von = excluded.geaendert_von;
update tco.verein set n8n_ep3_url = null, n8n_ep3_auth = null, n8n_ep3_user = null,
                      n8n_stunden_url = null, n8n_stunden_auth = null, n8n_stunden_user = null, n8n_ferien_url = null where id = 1;
