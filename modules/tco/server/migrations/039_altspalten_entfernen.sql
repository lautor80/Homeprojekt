-- Anbindungen zentral, Schritt 5: Die Zugänge stehen seit 036–038 in core.verbindungen (Administration → Anbindungen),
-- das Mailprotokoll in core.mail_protokoll. Die geleerten Altspalten und die alte Protokolltabelle entfallen.
-- Sicherheitsnetz: Steht in einer Altspalte noch ein Wert, ohne dass es die zentrale Anbindung gibt (z. B. nach einer
-- Rücksicherung einer älteren Sicherung zwischen den Updates), wird er vorher übernommen.
insert into core.verbindungen (id, url, auth_art, geheimnis, geaendert_von)
select 'paperless', v.paperless_url, 'token', v.paperless_token, 'Migration tco 039'
  from tco.verein v where v.id = 1 and coalesce(v.paperless_url, '') <> ''
on conflict (id) do nothing;
insert into core.verbindungen (id, url, auth_art, header_name, geheimnis, einstellungen, geaendert_von)
select 'mail', v.n8n_mail_url, case when v.n8n_mail_key is not null then 'header' else 'keine' end, 'X-TCO-Key', v.n8n_mail_key,
       jsonb_build_object('absender', coalesce(v.mail_absender, '[]'::jsonb)), 'Migration tco 039'
  from tco.verein v where v.id = 1 and coalesce(v.n8n_mail_url, '') <> ''
on conflict (id) do nothing;
insert into core.mail_protokoll (zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht, erneut_am, erneut_von, erneut_status)
select zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht, erneut_am, erneut_von, erneut_status
  from tco.mail_protokoll order by id;

drop table if exists tco.mail_protokoll;
alter table tco.verein
  drop column if exists paperless_url, drop column if exists paperless_token,
  drop column if exists n8n_mail_url, drop column if exists n8n_mail_key, drop column if exists mail_absender,
  drop column if exists n8n_ep3_url, drop column if exists n8n_ep3_auth, drop column if exists n8n_ep3_user,
  drop column if exists n8n_stunden_url, drop column if exists n8n_stunden_auth, drop column if exists n8n_stunden_user,
  drop column if exists n8n_ferien_url;
-- Änderungsbelege ohne die entfallenen Geheimnis-Spalten
select core.enable_audit('tco.verein', 'TCO_VEREIN', 'id', '', 'updated_at,logo');
