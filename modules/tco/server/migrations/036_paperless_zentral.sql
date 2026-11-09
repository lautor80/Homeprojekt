-- Paperless-Zugang in die zentrale Anbindung übernehmen (Administration → Anbindungen, core.verbindungen).
-- Die Werte des Vereins haben Vorrang vor denen anderer Module.
insert into core.verbindungen (id, url, auth_art, geheimnis, geaendert_von)
select 'paperless', v.paperless_url, 'token', v.paperless_token, 'Migration tco'
  from tco.verein v
 where v.id = 1 and coalesce(v.paperless_url, '') <> ''
on conflict (id) do update set url = excluded.url, auth_art = 'token', geheimnis = coalesce(excluded.geheimnis, core.verbindungen.geheimnis),
  geaendert_am = now(), geaendert_von = excluded.geaendert_von;
-- Spalten bleiben (ältere Sicherungen), werden aber nicht mehr gelesen: Geheimnis entfernen
update tco.verein set paperless_url = null, paperless_token = null where id = 1;
