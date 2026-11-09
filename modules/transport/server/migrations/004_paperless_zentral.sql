-- Paperless-Zugang in die zentrale Anbindung übernehmen (Administration → Anbindungen, core.verbindungen).
-- Ein bereits vorhandener Eintrag bleibt; das TCO-Modul (läuft danach) hat Vorrang.
insert into core.verbindungen (id, url, auth_art, geheimnis, geaendert_von)
select 'paperless', f.paperless_url, 'token', nullif(f.paperless_token, ''), 'Migration transport'
  from transport.firma f
 where f.id = 1 and f.paperless_url <> ''
on conflict (id) do nothing;
-- Spalten bleiben (ältere Sicherungen), werden aber nicht mehr gelesen: Geheimnis entfernen
update transport.firma set paperless_url = '', paperless_token = '' where id = 1;
