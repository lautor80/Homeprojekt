-- Dokumenteneingang (Issue „Maileingang: Ablage der Dokumente“): n8n meldet eingegangene E-Mails samt Anhängen,
-- das Portal entscheidet nach einem pflegbaren Regelwerk, legt die Dokumente in Paperless (und optional der Nextcloud) ab
-- und gibt n8n zurück, was mit der E-Mail geschehen soll. Unklare Fälle landen in der Prüfliste.

-- Korrespondenten: mehrere Adressen/Domains je Partner – ersetzt den Absender-Switch im n8n-Workflow
create table if not exists tco.eing_korrespondenten (
  id        serial primary key,
  name      text not null,
  kurz      text not null default '',
  -- Adressen und Domains, durch Komma oder Zeilenumbruch getrennt (z. B. „sumup.com, rechnung@telekom.de“)
  adressen  text not null default ''
);
create unique index if not exists eing_korrespondenten_name_idx on tco.eing_korrespondenten (lower(name));
select core.enable_audit('tco.eing_korrespondenten', 'EING_KORRESPONDENT', 'id');

create table if not exists tco.eing_regeln (
  id            serial primary key,
  name          text not null,
  beschreibung  text not null default '',
  -- testlauf = Regel wird ausgewertet, aber nichts abgelegt: der Vorschlag steht in der Prüfliste
  status        text not null default 'testlauf' check (status in ('aktiv', 'testlauf', 'aus')),
  prioritaet    int not null default 100,
  -- anhang = je Anhang einmal, mail = einmal je E-Mail (die E-Mail selbst ist das Dokument)
  gilt_fuer     text not null default 'anhang' check (gilt_fuer in ('anhang', 'mail')),
  verknuepfung  text not null default 'und' check (verknuepfung in ('und', 'oder')),
  bedingungen   jsonb not null default '[]',
  extraktion    jsonb not null default '[]',
  aktionen      jsonb not null default '{}',
  -- immer = bei Treffer sofort ablegen, pruefen = Vorschlag in die Prüfliste
  automatik     text not null default 'immer' check (automatik in ('immer', 'pruefen')),
  version       int not null default 1,
  geaendert_am  timestamptz not null default now(),
  geaendert_von text
);
select core.enable_audit('tco.eing_regeln', 'EING_REGEL', 'id', '', 'geaendert_am,geaendert_von,version');

-- Ein Vorgang je E-Mail (Schlüssel: Postfach + Message-ID). Der Mailtext wird nur aufbewahrt, solange der Vorgang
-- in der Prüfliste steht oder fehlgeschlagen ist; nach dem Abschluss wird er gelöscht.
create table if not exists tco.eing_vorgaenge (
  id               bigserial primary key,
  postfach         text not null default '',
  message_id       text not null,
  ordner           text,
  uid              text,
  von              text,
  von_name         text,
  an               text,
  betreff          text,
  datum            timestamptz,
  eingang_am       timestamptz not null default now(),
  status           text not null default 'neu' check (status in ('neu', 'pruefen', 'fehler', 'abgelegt', 'ohne_regel', 'ignoriert')),
  hinweis          text,
  mitglied_adrnr   text,
  korrespondent    text,
  text             text,
  mail_aktion      jsonb,
  mail_erledigt_am timestamptz,
  abgeschlossen_am timestamptz,
  unique (postfach, message_id)
);
create index if not exists eing_vorgaenge_status_idx on tco.eing_vorgaenge (status, id desc);

-- Dokumente eines Vorgangs (Anhänge bzw. die E-Mail selbst). Inhalt (Base64) und Kontext stehen nur bis zur Ablage hier.
create table if not exists tco.eing_dokumente (
  id             bigserial primary key,
  vorgang_id     bigint not null references tco.eing_vorgaenge(id) on delete cascade,
  art            text not null default 'anhang' check (art in ('anhang', 'mail')),
  datei          text not null,
  mime           text,
  groesse        int not null default 0,
  sha256         text,
  inhalt         text,
  kontext        jsonb,
  regel_id       int,
  regel_name     text,
  regel_version  int,
  status         text not null default 'neu' check (status in ('neu', 'pruefen', 'fehler', 'abgelegt', 'dublette', 'ignoriert')),
  hinweis        text,
  zuordnung      jsonb,
  paperless_id   int,
  nextcloud_pfad text,
  bearbeitet_am  timestamptz,
  bearbeitet_von text
);
create index if not exists eing_dokumente_vorgang_idx on tco.eing_dokumente (vorgang_id);
create index if not exists eing_dokumente_sha_idx on tco.eing_dokumente (sha256) where paperless_id is not null;

-- Rolle für Regelwerk und Prüfliste (eine Rolle für beides); die Berechtigungen lassen sich in der Rollenpflege ändern
insert into core.roles (id, name, description, system)
values ('DOKUMENTENEINGANG', 'Dokumenteneingang', 'Regelwerk des Dokumenteneingangs pflegen und die Prüfliste bearbeiten (eingegangene E-Mails und Anhänge ablegen).', false)
on conflict (id) do nothing;
insert into core.role_permissions (role_id, permission)
values ('DOKUMENTENEINGANG', 'tco.eingang:display'), ('DOKUMENTENEINGANG', 'tco.eingang:edit')
on conflict do nothing;
