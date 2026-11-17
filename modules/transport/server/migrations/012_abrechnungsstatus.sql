-- Auftragsliste: Lade-/Entladezeiten in der Spalte Route und Spalte „Abrechnung“ (angelegt · abgerechnet · bezahlt).
-- Doku: docs/euroflex-auftragsliste.md

-- Zahlungseingang der Rechnung. Bei einer Sammelrechnung tragen alle Aufträge der Rechnung dasselbe Datum.
-- „Ohne Rechnung abgeschlossen“ braucht keine Zahlung und gilt in der Liste als bezahlt (ohne Eintrag hier).
alter table transport.auftraege add column if not exists bezahlt_am date;

-- Niemand verliert etwas: Wer Aufträge sieht, sieht auch Ladezeiten und Abrechnungsstatus;
-- wer Rechnungen erstellen darf, darf den Zahlungseingang erfassen.
insert into core.role_permissions (role_id, permission)
select role_id, p from core.role_permissions, unnest(array['transport.ladezeiten:display', 'transport.abrechnung:display']) p
 where permission = 'transport.auftraege:display'
on conflict do nothing;
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.zahlungen:edit' from core.role_permissions where permission = 'transport.rechnungen:create'
on conflict do nothing;
