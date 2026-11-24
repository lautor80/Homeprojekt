-- Vorstandssitzungen: Nummer im Jahr (VS <jahr>/<lfd>) aufsteigend nach dem Datum der Sitzung (bei verknüpfter
-- Veranstaltung deren Datum), bei gleichem Datum nach Beginn und Anlage. Jahr = Jahr dieses Datums.
-- Die Logik (vorstand/logik.ts, nummernOrdnen) hält die Reihenfolge danach bei jeder Änderung aktuell.
with neu as (
  select x.id, extract(year from x.d)::int as jahr,
         row_number() over (partition by extract(year from x.d) order by x.d, x.beginn nulls last, x.id)::int as lfd
    from (select s.id, s.beginn, coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as d
            from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id) x
)
update tco.vs_sitzungen s set lfd = -s.id
  from neu where neu.id = s.id and (s.jahr, s.lfd) is distinct from (neu.jahr, neu.lfd);

with neu as (
  select x.id, extract(year from x.d)::int as jahr,
         row_number() over (partition by extract(year from x.d) order by x.d, x.beginn nulls last, x.id)::int as lfd
    from (select s.id, s.beginn, coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as d
            from tco.vs_sitzungen s left join tco.kal_events e on e.id = s.event_id) x
)
update tco.vs_sitzungen s set jahr = neu.jahr, lfd = neu.lfd
  from neu where neu.id = s.id and s.lfd < 0;
