-- Nextcloud: ein Zugang statt zwei (#232, S2). Bisher fragte die Sicherung Adresse, Benutzer und App-Passwort selbst ab
-- (core.backup_export), und für die Dokumentenablage des Vereins gab es die Anbindung „tco.nextcloud“ mit denselben Angaben.
-- Künftig gibt es die eine Anbindung „nextcloud“ (Administration → Schnittstellen → Nextcloud); beide lesen sie.
-- Übernommen wird der Zugang der Sicherung, sonst der der Dokumentenablage (laut Betreiber derselbe Benutzer).
-- Die alten Angaben bleiben stehen, werden aber nicht mehr gelesen.
insert into core.verbindungen (id, url, auth_art, auth_user, geheimnis, einstellungen, geaendert_am, geaendert_von)
select 'nextcloud', b.url, 'basic', b.benutzer, nullif(b.passwort, ''), '{}'::jsonb, now(), 'Migration'
  from core.backup_export b
 where b.id = 1 and b.url <> '' and b.benutzer <> ''
on conflict (id) do nothing;

insert into core.verbindungen (id, url, auth_art, auth_user, geheimnis, einstellungen, geaendert_am, geaendert_von)
select 'nextcloud', v.url, 'basic', v.auth_user, v.geheimnis, '{}'::jsonb, now(), 'Migration'
  from core.verbindungen v
 where v.id = 'tco.nextcloud' and v.url <> ''
on conflict (id) do nothing;
