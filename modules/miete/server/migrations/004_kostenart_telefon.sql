-- Kostenart Telefon/Internet: gemeinsamer Anschluss, hälftig bzw. zu gleichen Teilen je Wohnung.
-- Umlagefähig, damit der Anteil in der Abrechnung der Parteien erscheint (keine Betriebskosten nach BetrKV – vertraglich vereinbart).
insert into miete.kostenarten (bezeichnung, umlagefaehig, schluessel, p35a, sort)
values ('Telefon/Internet', true, 'einheiten', false, 45)
on conflict (bezeichnung) do nothing;
