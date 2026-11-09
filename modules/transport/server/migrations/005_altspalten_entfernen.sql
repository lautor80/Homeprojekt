-- Anbindungen zentral, Schritt 5: Paperless-Zugang steht seit 004 in core.verbindungen (Administration → Anbindungen).
-- Sicherheitsnetz wie beim Verein: noch vorhandener Wert ohne zentrale Anbindung wird vorher übernommen.
insert into core.verbindungen (id, url, auth_art, geheimnis, geaendert_von)
select 'paperless', f.paperless_url, 'token', nullif(f.paperless_token, ''), 'Migration transport 005'
  from transport.firma f where f.id = 1 and coalesce(f.paperless_url, '') <> ''
on conflict (id) do nothing;
alter table transport.firma drop column if exists paperless_url, drop column if exists paperless_token;
select core.enable_audit('transport.firma', 'FIRMA', 'id', '', 'updated_at');
