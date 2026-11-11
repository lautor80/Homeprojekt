-- #3: FI-Perioden abschließen. In einer abgeschlossenen Periode (Monat) werden keine Buchungen mehr erfasst, storniert
-- oder in ihren Werten geändert. Die Sperre greift in der Datenbank (Trigger) – für Bankimport, manuelle Buchung, Storno
-- und jeden anderen Weg; Verweise (Rechnung, Projekt, Paperless) dürfen weiter gepflegt werden.
create table if not exists tco.fiperioden (
  jahr int not null,
  monat int not null check (monat between 1 and 12),
  geschlossen_am timestamptz not null default now(),
  geschlossen_von text default nullif(current_setting('app.username', true), ''),
  primary key (jahr, monat)
);
select core.enable_audit('tco.fiperioden', 'FIPERIODE', 'jahr,monat', '', 'geschlossen_am');

create or replace function tco.fi_periode_pruefen() returns trigger language plpgsql as $$
declare
  j int; m int;
begin
  if tg_op = 'UPDATE' and (new.internenr, new.konto, new.posnr, new.jahr, new.monat, new.datum, new.text, new.betrag, new.soll,
                           new.haben, new.belnr, new.gkonto, new.storno_zu)
                 is not distinct from (old.internenr, old.konto, old.posnr, old.jahr, old.monat, old.datum, old.text, old.betrag, old.soll,
                           old.haben, old.belnr, old.gkonto, old.storno_zu) then
    return new;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    j := coalesce(old.jahr, extract(year from old.datum)::int); m := coalesce(old.monat, extract(month from old.datum)::int);
    if exists (select 1 from tco.fiperioden p where p.jahr = j and p.monat = m) then
      raise exception using errcode = 'FP409',
        message = format('Die Periode %s/%s ist abgeschlossen – Buchungen darin können nicht mehr storniert oder geändert werden.', lpad(m::text, 2, '0'), j);
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    j := coalesce(new.jahr, extract(year from new.datum)::int); m := coalesce(new.monat, extract(month from new.datum)::int);
    if exists (select 1 from tco.fiperioden p where p.jahr = j and p.monat = m) then
      raise exception using errcode = 'FP409',
        message = format('Die Periode %s/%s ist abgeschlossen – darin können keine Buchungen oder Stornos mehr erfasst werden.', lpad(m::text, 2, '0'), j);
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists fibuchungen_periode on tco.fibuchungen;
create trigger fibuchungen_periode before insert or update or delete on tco.fibuchungen
  for each row execute function tco.fi_periode_pruefen();

-- Recht „Perioden abschließen“ zunächst für alle, die stornieren dürfen
insert into core.role_permissions (role_id, permission)
select distinct role_id, 'tco.fi:periode' from core.role_permissions where permission = 'tco.fi:storno'
on conflict do nothing;
