-- Euroflex Mail-Workflows: Eingang aus Outlook 365 (n8n → Portal, Zuordnung zum Auftrag) und Sammelversand
-- über n8n (Entwurf oder direkt senden). Doku: docs/euroflex-mailworkflows.md

-- Einstellungen beider Workflows (eine Zeile). Eingang: Schwelle, Ablageziel, Speicherwarnung …; Versand: Modus und
-- Vorauswahl je Dokumentart T/L/R. Aufbau und Standardwerte: modules/transport/server/mailworkflows.ts
create table if not exists transport.workflow_einstellungen (
  id       int primary key default 1 check (id = 1),
  eingang  jsonb not null default '{}',
  versand  jsonb not null default '{}'
);
insert into transport.workflow_einstellungen (id) values (1) on conflict do nothing;
select core.enable_audit('transport.workflow_einstellungen', 'MAILWORKFLOW', 'id');

-- Ein Vorgang je eingegangener E-Mail (Schlüssel: Postfach + Message-ID). Der Mailtext wird nach dem Abschluss gelöscht.
create table if not exists transport.eing_vorgaenge (
  id               bigserial primary key,
  postfach         text not null default '',
  message_id       text not null,
  graph_id         text,
  von              text,
  von_name         text,
  an               text,
  betreff          text,
  datum            timestamptz,
  eingang_am       timestamptz not null default now(),
  status           text not null default 'neu' check (status in ('neu', 'pruefen', 'fehler', 'abgelegt', 'ignoriert')),
  hinweis          text,
  text             text,
  -- Zuordnung: gewählter Auftrag, Trefferwert 0–100, Begründungen [{grund, punkte}], Kandidaten [{auftragsnr, punkte, gruende}]
  -- bewusst ohne Fremdschlüssel: der SAP-Neuaufbau leert transport.auftraege per TRUNCATE
  auftragsnr       text,
  punkte           int not null default 0,
  begruendung      jsonb not null default '[]',
  kandidaten       jsonb not null default '[]',
  -- Rückmeldung an n8n: {ordner: 'Portal/Zugeordnet' | 'Portal/Prüfen'}
  mail_aktion      jsonb,
  mail_erledigt_am timestamptz,
  abgeschlossen_am timestamptz,
  bearbeitet_von   text,
  unique (postfach, message_id)
);
create index if not exists eing_vorgaenge_status_idx on transport.eing_vorgaenge (status, id desc);
create index if not exists eing_vorgaenge_auftrag_idx on transport.eing_vorgaenge (auftragsnr);

-- Dokumente eines Vorgangs (Anhänge und die E-Mail selbst als PDF). inhalt (Base64) steht nur so lange hier, bis die
-- Datei in den Ablageordner des PCs übernommen oder in Paperless abgelegt ist – danach wird er gelöscht (nie vorher).
create table if not exists transport.eing_dokumente (
  id             bigserial primary key,
  vorgang_id     bigint not null references transport.eing_vorgaenge(id) on delete cascade,
  art            text not null default 'anhang' check (art in ('anhang', 'mail')),
  datei          text not null,
  mime           text,
  groesse        int not null default 0,
  sha256         text,
  inhalt         text,
  ocr_text       text,
  status         text not null default 'neu' check (status in ('neu', 'wartet', 'uebernommen', 'abgelegt', 'dublette', 'ignoriert', 'fehler')),
  -- lokal = wartet auf Übernahme in den Ablageordner (Unterordner Eingang/), paperless = in Paperless abgelegt
  ziel           text check (ziel in ('lokal', 'paperless')),
  paperless_id   int,
  hinweis        text,
  bearbeitet_am  timestamptz,
  bearbeitet_von text
);
create index if not exists eing_dokumente_vorgang_idx on transport.eing_dokumente (vorgang_id);
create index if not exists eing_dokumente_sha_idx on transport.eing_dokumente (sha256);
create index if not exists eing_dokumente_wartet_idx on transport.eing_dokumente (status) where inhalt is not null;

-- Posteingang bekommt, wer Aufträge versenden darf; „direkt senden“ (transport.versandsenden:execute) wird bewusst
-- niemandem automatisch gegeben.
insert into core.role_permissions (role_id, permission)
select role_id, p from core.role_permissions, unnest(array['transport.eingang:display', 'transport.eingang:edit']) p
 where permission = 'transport.versand:execute'
on conflict do nothing;
