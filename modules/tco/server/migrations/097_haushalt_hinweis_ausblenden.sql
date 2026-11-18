-- Haushalt: Hinweise „Budget überschritten“ (Konto, je Geschäftsjahr) und „Projektbudget überschritten“ (Projekt, jahr = 0)
-- lassen sich im Arbeitsvorrat abwählen und erscheinen danach nicht mehr; im Soll-Ist wieder einblendbar.
create table if not exists tco.hh_hinweis_aus (
  schluessel text not null,
  jahr       int  not null,
  am         timestamptz not null default now(),
  von        text,
  primary key (schluessel, jahr)
);
select core.enable_audit('tco.hh_hinweis_aus', 'HH_PLAN', 'schluessel', '', 'am');
