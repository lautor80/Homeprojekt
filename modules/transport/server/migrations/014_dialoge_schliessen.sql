-- Versand- und Druckdialoge schließen sich nach dem Auslösen sofort (Funktionsschalter transport.dialoge.schliessen).
-- Doku: docs/euroflex-mailworkflows.md, „Dialoge schließen sofort“. Jede Rolle, die Aufträge sieht, erhält das Recht.
insert into core.role_permissions (role_id, permission)
select role_id, 'transport.dialoge:execute' from core.role_permissions where permission = 'transport.auftraege:display'
on conflict do nothing;
