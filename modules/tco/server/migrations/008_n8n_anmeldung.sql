-- n8n-Webhooks: Anmeldung per Benutzer/Passwort (Basic Auth wie in SM59); der Header wird daraus gebildet
alter table tco.verein
  add column if not exists n8n_stunden_user text,
  add column if not exists n8n_ep3_user text;
