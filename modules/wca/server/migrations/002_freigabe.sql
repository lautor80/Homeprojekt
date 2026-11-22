-- Freigaben: ein bemängelter Text gilt für eine Regel und einen Account als in Ordnung und wird nicht mehr gemeldet
-- (für alle Personen und Tage). Schlüssel = Regel + Account (roh) + Text normalisiert (getrimmt, Leerraum zusammengefasst, klein).
create table wca.freigabe (
  id               uuid primary key default gen_random_uuid(),
  regel            text not null,
  acc              text not null default '',          -- Account roh („Name|Kunde“) wie im Import
  text_norm        text not null,                     -- normalisierter Text (Vergleichsschlüssel)
  text             text not null,                     -- Text, wie er beim Freigeben angezeigt wurde
  person           text not null default '',          -- Person, bei der freigegeben wurde (nur zur Info)
  meldung          text not null default '',          -- Meldung zum Zeitpunkt der Freigabe (nur zur Info)
  freigegeben_von  text,
  freigegeben_am   timestamptz not null default now(),
  unique (regel, acc, text_norm)
);
select core.enable_audit('wca.freigabe', 'WCA_FREIGABE', 'id', '', 'freigegeben_am');
