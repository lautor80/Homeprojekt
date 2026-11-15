-- Platz buchen für die Familie: Wer spielt, wenn die Buchung auf einen anderen Namen läuft.
-- bookings.kunde ist die Person, die die Rechnung bekommt (so rechnet die Hallenabrechnung ab): die Person selbst oder –
-- wenn sie über jemanden zahlt – ihr abweichender Zahler. spieler nennt dann, für wen gebucht wurde; leer = Kunde spielt selbst.
alter table tco.bookings add column if not exists spieler text;
comment on column tco.bookings.spieler is 'Platz buchen: für wen gebucht wurde, wenn die Rechnung an eine andere Person geht oder ein Familienmitglied gebucht hat';
