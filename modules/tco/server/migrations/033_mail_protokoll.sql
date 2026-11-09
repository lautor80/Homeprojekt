-- Protokoll aller E-Mail-Versuche über n8n (Diagnose: kam der Aufruf bei n8n an, welcher Absender, welcher Fehler)
create table if not exists tco.mail_protokoll (
  id        bigserial primary key,
  zeit      timestamptz not null default now(),
  anwendung text, objekt text, an text, betreff text,
  absender  text,              -- gewünschter Absender (Bearbeiter bzw. Ersatz)
  von       text,              -- tatsächlicher Absender laut n8n
  status    text not null,     -- gesendet | entwurf | fehler | nicht_gesendet
  fehler    text,
  benutzer  text
);
create index if not exists mail_protokoll_zeit_idx on tco.mail_protokoll (zeit desc);
