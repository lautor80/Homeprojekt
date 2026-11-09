-- Mitgliedergruppen (Issue #33): Wer in einer Untergruppe ist, gehört zwingend auch zu den Gruppen darüber und wird
-- dort nicht noch einmal geführt. Bestehende doppelte Zuordnungen entlang einer Linie (Gruppe – Untergruppe) entfallen
-- in der übergeordneten Gruppe; Zuordnungen in parallelen Gruppen bleiben.
with recursive linie as (
  select id as oben, id as unten from tco.kal_gruppen
  union
  select l.oben, k.id from tco.kal_gruppen k join linie l on k.parent_id = l.unten
)
delete from tco.kal_gruppe_mitglieder gm
 using linie l, tco.kal_gruppe_mitglieder u
 where l.oben = gm.gruppe_id and l.unten <> l.oben and u.gruppe_id = l.unten and u.adrnr = gm.adrnr;
