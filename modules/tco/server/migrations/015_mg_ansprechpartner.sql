-- Ansprechpartner-Block in den Mitglieder-Mailtexten kommt aus den Stammdaten statt aus dem Code
-- (keine personenbezogenen Daten im Quelltext). Eine Zeile je Ansprechpartner, leer = Block entfällt.
alter table tco.verein
  add column if not exists mg_ansprechpartner text not null default '';
