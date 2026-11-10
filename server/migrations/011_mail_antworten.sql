-- Rückmeldungen zu gesendeten E-Mails (E-Mail-Protokoll): Unzustellbar-Meldungen des Mailservers, Abwesenheitsnotizen und
-- Antworten der Empfänger. n8n liest die Postfächer der Absender (Workflow „TCO Maileingang“) und meldet jede Mail an
-- POST /api/mail/eingang; gespeichert wird nur, was sich einer gesendeten E-Mail zuordnen lässt – Absender, Betreff, Zeit und
-- bei Rückläufern die Fehlerzeilen des Mailservers, nie der Inhalt. Gelöscht wird mit dem Protokolleintrag (180 Tage).
alter table core.mail_protokoll add column if not exists message_id text;  -- Message-ID der gesendeten E-Mail laut n8n (ohne spitze Klammern)
create index if not exists mail_protokoll_message_id_idx on core.mail_protokoll (message_id) where message_id is not null;

create table if not exists core.mail_antworten (
  id           bigserial primary key,
  protokoll_id bigint not null references core.mail_protokoll(id) on delete cascade,
  art          text not null check (art in ('unzustellbar', 'abwesenheit', 'antwort')),
  zeit         timestamptz not null default now(),  -- Datum der eingegangenen E-Mail
  von          text,
  betreff      text,
  grund        text,                                -- Rückläufer: Fehlerzeilen des Mailservers
  postfach     text,                                -- in welchem Postfach sie einging
  message_id   text,                                -- Message-ID der eingegangenen E-Mail (gegen doppeltes Verbuchen)
  erfasst      timestamptz not null default now()
);
create index if not exists mail_antworten_protokoll_idx on core.mail_antworten (protokoll_id);
create unique index if not exists mail_antworten_uq on core.mail_antworten (protokoll_id, message_id) where message_id is not null;
