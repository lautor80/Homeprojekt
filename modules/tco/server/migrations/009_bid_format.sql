-- Buchungsnummern (BID) einheitlich im SAP-Format (10 Stellen mit führenden Nullen).
-- Aus SAP übernommene Sätze tragen „0000004305“, der EP3-Import im Portal legte „4305“ an:
-- dadurch gab es Buchungen doppelt (abgerechnet/irrelevant aus SAP und offen aus EP3),
-- und „Abo als Einzel“ (bookings_ch) sowie Buchungstexte griffen nicht.

alter table tco.bookings add column if not exists platz text;

-- 1. Buchungen: Duplikate zusammenführen, SAP-Satz (mit Zuordnung) bleibt maßgeblich
update tco.bookings p
   set time_start = n.time_start, time_ende = n.time_ende, kunde = n.kunde, status = n.status, description = n.description,
       preis = n.preis, geaendert = coalesce(n.geaendert, n.erstellt), text = coalesce(n.text, p.text)
  from tco.bookings n
 where n.bid ~ '^[0-9]{1,9}$' and p.bid = lpad(n.bid, 10, '0') and p.datum = n.datum
   and coalesce(p.assigned, '') = '' and coalesce(n.assigned, '') = '';
update tco.bookings p
   set assigned = n.assigned
  from tco.bookings n
 where n.bid ~ '^[0-9]{1,9}$' and p.bid = lpad(n.bid, 10, '0') and p.datum = n.datum
   and coalesce(p.assigned, '') = '' and coalesce(n.assigned, '') <> '';
delete from tco.bookings n
 using tco.bookings p
 where n.bid ~ '^[0-9]{1,9}$' and p.bid = lpad(n.bid, 10, '0') and p.datum = n.datum;

-- 2. übrige Sätze umschlüsseln; neue Termine bereits abgerechneter/irrelevanter Abo-Serien erben die Kennzeichnung
create temp table bid_neu as
  select bid as alt, lpad(bid, 10, '0') as neu, datum from tco.bookings where bid ~ '^[0-9]{1,9}$';
update tco.bookings set bid = lpad(bid, 10, '0') where bid ~ '^[0-9]{1,9}$';

-- 3. Abo als Einzel und Buchungstexte
delete from tco.bookings_ch p using tco.bookings_ch n
 where n.bid ~ '^[0-9]{1,9}$' and p.bid = lpad(n.bid, 10, '0');
update tco.bookings_ch set bid = lpad(bid, 10, '0') where bid ~ '^[0-9]{1,9}$';
delete from tco.bookingstxt p using tco.bookingstxt n
 where n.bid ~ '^[0-9]{1,9}$' and p.bid = lpad(n.bid, 10, '0');
update tco.bookingstxt set bid = lpad(bid, 10, '0') where bid ~ '^[0-9]{1,9}$';
update tco.rgpos set bid = lpad(bid, 10, '0') where bid ~ '^[0-9]{1,9}$';

update tco.bookings b
   set assigned = s.assigned
  from bid_neu x,
       lateral (select max(o.assigned) as assigned from tco.bookings o
                 where o.bid = x.neu and coalesce(o.assigned, '') <> '') s
 where b.bid = x.neu and b.datum = x.datum and b.status = '3' and coalesce(b.assigned, '') = '' and s.assigned is not null
   and not exists (select 1 from tco.bookings_ch c where c.bid = b.bid and c.status_abw = '1');
drop table bid_neu;

-- Plätze, die auch im Sommer (01.05.–30.09.) als Abo abgerechnet werden
alter table tco.verein add column if not exists halle_plaetze text not null default 'Halle';
