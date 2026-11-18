-- Posteingang: wer die Ablage einer E-Mail bestätigt hat. Seit dieser Version wird nie mehr automatisch abgelegt; bisher
-- automatisch abgelegte E-Mails bleiben als „automatisch abgelegt“ erkennbar (Bearbeiter „Posteingang (automatisch)“).
alter table transport.eing_vorgaenge add column if not exists abgelegt_von text;

update transport.eing_vorgaenge v
   set abgelegt_von = 'Posteingang (automatisch)'
 where v.status = 'abgelegt' and v.abgelegt_von is null
   and exists (select 1 from transport.eing_dokumente d where d.vorgang_id = v.id and d.bearbeitet_von = 'Posteingang (automatisch)');
