-- Mitgliedergruppen (Issue #16): Position der Gruppe innerhalb ihrer Ebene – danach wird der Baum geführt
-- (kleinste Position zuerst, Gruppen ohne Position danach nach Name).
alter table tco.kal_gruppen add column if not exists position int;
