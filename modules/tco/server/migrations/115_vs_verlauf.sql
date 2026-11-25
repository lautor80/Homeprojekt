-- Vorstandssitzungen: Verlauf eines Themas über mehrere Sitzungen („Kette“).
-- Zusammenhängende Tagesordnungspunkte tragen dieselbe Kennung kette (= Id des ersten Punkts der Kette; leer = der Punkt
-- selbst). Ein Thema im Themenparkplatz merkt sich seine Kette, damit sie auch beim Parken und Wiederaufnehmen erhalten bleibt.
alter table tco.vs_tops   add column if not exists kette int;
alter table tco.vs_themen add column if not exists kette int;
create index if not exists vs_tops_kette_idx on tco.vs_tops (kette) where kette is not null;
create index if not exists vs_themen_kette_idx on tco.vs_themen (kette) where kette is not null;

-- Bestand: Ein Punkt setzt den letzten gleichnamigen Punkt einer früheren Sitzung fort, wenn dieser vertagt wurde.
do $$
declare r record; v record;
begin
  for r in select t.id, lower(btrim(t.titel)) as titel, s.id as sid, coalesce((e.beginn at time zone 'Europe/Berlin')::date, s.datum) as d
             from tco.vs_tops t join tco.vs_sitzungen s on s.id = t.sitzung_id left join tco.kal_events e on e.id = s.event_id
            where t.kette is null
            order by 4, s.id, t.pos, t.id
  loop
    select p.id, p.kette, p.status into v
      from tco.vs_tops p join tco.vs_sitzungen ps on ps.id = p.sitzung_id left join tco.kal_events pe on pe.id = ps.event_id
     where lower(btrim(p.titel)) = r.titel and ps.id <> r.sid
       and (coalesce((pe.beginn at time zone 'Europe/Berlin')::date, ps.datum), ps.id) < (r.d, r.sid)
     order by coalesce((pe.beginn at time zone 'Europe/Berlin')::date, ps.datum) desc, ps.id desc, p.id desc
     limit 1;
    if found and v.status = 'VERTAGT' then
      update tco.vs_tops set kette = coalesce(v.kette, v.id) where id = r.id;
    end if;
  end loop;
end $$;

-- Themen: Kette des zugeordneten Punkts, sonst des gleichnamigen Punkts der Sitzung, in der es zuletzt war
update tco.vs_themen th set kette = coalesce(t.kette, t.id)
  from tco.vs_tops t where t.id = th.top_id and th.kette is null;
update tco.vs_themen th
   set kette = (select coalesce(t.kette, t.id) from tco.vs_tops t
                 where t.sitzung_id = th.zuletzt_sitzung_id and lower(btrim(t.titel)) = lower(btrim(th.titel)) order by t.id desc limit 1)
 where th.kette is null and th.zuletzt_sitzung_id is not null;
