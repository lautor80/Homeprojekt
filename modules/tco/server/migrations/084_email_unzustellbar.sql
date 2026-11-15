-- E-Mail-Adresse „unzustellbar“ im Mitgliederstamm: Schlägt das Senden dauerhaft fehl (Adresse gibt es nicht) oder kommt ein
-- Rückläufer, wird das beim Mitglied vermerkt; an die vermerkte Adresse sendet das Portal nicht mehr (modules/tco/server/emailsperre.ts).
-- Die betroffene Adresse steht dabei: Gesperrt ist die Adresse, nicht die Person – mit einer neuen Adresse entfällt der Vermerk.
alter table tco.mitglieder
  add column if not exists email_unzustellbar_seit    timestamptz,
  add column if not exists email_unzustellbar_grund   text,
  add column if not exists email_unzustellbar_adresse text,
  add column if not exists email_unzustellbar_quelle  text;
comment on column tco.mitglieder.email_unzustellbar_seit    is 'E-Mail-Adresse unzustellbar seit (leer = erreichbar)';
comment on column tco.mitglieder.email_unzustellbar_grund   is 'Meldung des Mailservers bzw. Begründung des Bearbeiters';
comment on column tco.mitglieder.email_unzustellbar_adresse is 'die Adresse, die nicht zustellbar ist (klein geschrieben) – an sie wird nicht mehr gesendet';
comment on column tco.mitglieder.email_unzustellbar_quelle  is 'VERSAND (n8n meldet Empfängerfehler), RUECKLAEUFER (Unzustellbarkeitsnachricht), MANUELL';
create index if not exists mitglieder_email_unzustellbar_idx on tco.mitglieder (email_unzustellbar_adresse) where email_unzustellbar_seit is not null;

-- Der Vermerk entfällt von selbst, sobald die E-Mail-Adresse des Mitglieds geändert wird – gleich auf welchem Weg
-- (Stammdatenpflege, „Meine Daten“, Antrag, Import). Als Trigger, damit kein Schreibweg vergessen werden kann.
create or replace function tco.email_unzustellbar_aufheben() returns trigger language plpgsql as $$
begin
  if new.email_unzustellbar_seit is not null
     and lower(btrim(coalesce(new.email, ''))) is distinct from lower(btrim(coalesce(old.email, '')))
     and lower(btrim(coalesce(new.email, ''))) is distinct from lower(btrim(coalesce(new.email_unzustellbar_adresse, ''))) then
    new.email_unzustellbar_seit := null;
    new.email_unzustellbar_grund := null;
    new.email_unzustellbar_adresse := null;
    new.email_unzustellbar_quelle := null;
  end if;
  return new;
end $$;
drop trigger if exists email_unzustellbar_aufheben on tco.mitglieder;
create trigger email_unzustellbar_aufheben before update on tco.mitglieder
  for each row execute function tco.email_unzustellbar_aufheben();

-- Mitglieder ohne eigene Adresse werden über den EP3-Kundenstamm angeschrieben (gleicher Name): Ändert sich dort die Adresse,
-- entfällt der Vermerk zu der alten Adresse ebenfalls.
create or replace function tco.email_unzustellbar_kunde() returns trigger language plpgsql as $$
begin
  if lower(btrim(coalesce(new.email, ''))) is distinct from lower(btrim(coalesce(old.email, ''))) and btrim(coalesce(old.email, '')) <> '' then
    update tco.mitglieder
       set email_unzustellbar_seit = null, email_unzustellbar_grund = null, email_unzustellbar_adresse = null, email_unzustellbar_quelle = null
     where email_unzustellbar_seit is not null and btrim(coalesce(email, '')) = ''
       and email_unzustellbar_adresse = lower(btrim(old.email));
  end if;
  return new;
end $$;
drop trigger if exists email_unzustellbar_kunde on tco.kunden;
create trigger email_unzustellbar_kunde after update on tco.kunden
  for each row execute function tco.email_unzustellbar_kunde();
