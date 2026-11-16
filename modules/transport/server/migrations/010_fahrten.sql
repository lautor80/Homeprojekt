-- Mehrere Fahrten in einem Auftrag: Ein Kundentransport kann mit mehreren Fahrzeugen/Unternehmern gefahren werden.
-- Fahrt 1 bleibt im Auftrag selbst (unternehmer, kennzeichen, fahrzeugtyp, frachtpreis_vk) – Bestandsdaten ändern sich nicht.
-- Weitere Fahrten (Position ≥ 2) stehen hier; Änderungen erscheinen in der Historie des Auftrags.
create table transport.fahrten (
  auftragsnr      text not null references transport.auftraege(auftragsnr) on delete cascade,
  pos             smallint not null check (pos >= 2),
  unternehmer     integer references transport.adressen(adrnr),
  kennzeichen     text,
  fahrzeugtyp     text,
  frachtpreis_vk  numeric(15,2) not null default 0,   -- Preis des Unternehmers dieser Fahrt
  ladedatum       date,                               -- leer = Termin des ersten Stops
  primary key (auftragsnr, pos)
);
create index fahrten_unternehmer_idx on transport.fahrten (unternehmer);
select core.enable_audit('transport.fahrten', 'AUFTRAG', 'auftragsnr');

-- Ohne Rechnung abschließen (ersetzt das frühere „Ausbuchen mit 0 Euro“): Der Auftrag gilt nicht mehr als offen,
-- bekommt aber keine Rechnung. Wieder öffnen leert beide Felder.
alter table transport.auftraege
  add column abgeschlossen_am    date,
  add column abgeschlossen_grund text;
