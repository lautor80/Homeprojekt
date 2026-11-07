-- Gespeicherte Anzeigevarianten (Mitglieder-Analyse u. a.), aus SAP ZTCO_RPT_VARIANT
create table tco.rpt_variant (
  repid   text not null,
  uname   text not null,
  variant text not null,
  descr   text,
  isdef   text,
  changed text,          -- SAP TIMESTAMPL (JJJJMMTThhmmss,nnnnnnn)
  content text,          -- Inhalt (JSON/XML aus SAP)
  primary key (repid, uname, variant)
);
