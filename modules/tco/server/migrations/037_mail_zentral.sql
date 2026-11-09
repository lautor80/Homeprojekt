-- Mailversand in den Kern: Webhook und Ersatzabsender in die zentrale Anbindung „mail“ (Administration → Anbindungen),
-- Mailprotokoll nach core.mail_protokoll. Die alten Spalten/Tabelle bleiben leer stehen (ältere Sicherungen).
insert into core.verbindungen (id, url, auth_art, header_name, geheimnis, einstellungen, geaendert_von)
select 'mail', coalesce(v.n8n_mail_url, ''), case when v.n8n_mail_key is not null then 'header' else 'keine' end, 'X-TCO-Key', v.n8n_mail_key,
       jsonb_build_object('absender', coalesce(v.mail_absender, '[]'::jsonb)), 'Migration tco'
  from tco.verein v
 where v.id = 1 and (coalesce(v.n8n_mail_url, '') <> '' or jsonb_array_length(coalesce(v.mail_absender, '[]'::jsonb)) > 0)
on conflict (id) do update set url = excluded.url, auth_art = excluded.auth_art, header_name = excluded.header_name,
  geheimnis = coalesce(excluded.geheimnis, core.verbindungen.geheimnis), einstellungen = excluded.einstellungen,
  geaendert_am = now(), geaendert_von = excluded.geaendert_von;
insert into core.mail_protokoll (zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht, erneut_am, erneut_von, erneut_status)
select zeit, anwendung, objekt, an, betreff, absender, von, status, fehler, benutzer, nachricht, erneut_am, erneut_von, erneut_status
  from tco.mail_protokoll order by id;
delete from tco.mail_protokoll;
update tco.verein set n8n_mail_url = null, n8n_mail_key = null, mail_absender = '[]'::jsonb where id = 1;
