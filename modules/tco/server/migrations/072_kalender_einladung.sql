-- Vereinskalender: Einladungslink aus einer Veranstaltung versenden.
-- Festgehalten wird je Versand, wer wann wie viele Mitglieder eingeladen hat – damit im Dialog steht, ob und wann
-- schon eingeladen wurde. Die E-Mails selbst stehen im Mailprotokoll.
create table if not exists tco.kal_einladungen (
  id           serial primary key,
  event_id     int  not null references tco.kal_events(id) on delete cascade,
  an           text not null check (an in ('OFFEN', 'ALLE')),   -- ohne Rückmeldung / alle Eingeladenen
  gesendet     int  not null default 0,
  fehler       int  not null default 0,
  ohne_mail    int  not null default 0,
  gesendet_am  timestamptz not null default now(),
  gesendet_von text
);
create index if not exists kal_einladungen_event_idx on tco.kal_einladungen (event_id, gesendet_am desc);
select core.enable_audit('tco.kal_einladungen', 'KAL_EINLADUNG', 'id');
