-- #232 (E3): IBAN und BIC des Vereins nur noch an einer Stelle – Einstellungen → TC Oberthal → Verein und Bank.
-- Die Gläubigerdaten der Sollstellung (tco.soll_cfg) führten dieselben Angaben ein zweites Mal.
--
-- Ohne Verlust und ohne stilles Umstellen des Einzugskontos:
--   1. Hat der Verein noch keine IBAN, kommt die der Gläubigerdaten dorthin.
--   2. Fehlt dem Verein nur die BIC und die IBAN ist dieselbe, kommt die BIC dazu.
--   3. Stimmen die IBAN überein, entfällt die Kopie in den Gläubigerdaten – es gilt die des Vereins.
--   4. Weichen sie voneinander ab, bleibt die IBAN der Gläubigerdaten stehen und gilt weiter für die Lastschrift,
--      bis der Kassenwart entscheidet (Aufgabe im Arbeitsvorrat, Kapitel „Beitragseinzug“).
update tco.verein v
   set iban = c.iban, bic = coalesce(nullif(trim(coalesce(v.bic, '')), ''), c.bic)
  from tco.soll_cfg c
 where c.cfgid = 'TCO' and v.id = 1
   and trim(coalesce(v.iban, '')) = '' and trim(coalesce(c.iban, '')) <> '';

update tco.verein v
   set bic = c.bic
  from tco.soll_cfg c
 where c.cfgid = 'TCO' and v.id = 1
   and trim(coalesce(v.bic, '')) = '' and trim(coalesce(c.bic, '')) <> ''
   and upper(regexp_replace(coalesce(c.iban, ''), '\s', '', 'g')) = upper(regexp_replace(coalesce(v.iban, ''), '\s', '', 'g'));

update tco.soll_cfg c
   set iban = null, bic = null
  from tco.verein v
 where c.cfgid = 'TCO' and v.id = 1
   and upper(regexp_replace(coalesce(c.iban, ''), '\s', '', 'g')) = upper(regexp_replace(coalesce(v.iban, ''), '\s', '', 'g'));
