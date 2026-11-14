-- E-Mail-Texte des Vereins vorbelegen (#232): Administration → Einstellungen → TC Oberthal → E-Mail-Texte.
-- Eine Zeile gibt es erst, wenn der Verein einen Text selbst festgelegt hat; ohne Zeile gilt der Standardtext des Portals.
-- Die Schlüssel und Platzhalter stehen im Verzeichnis modules/tco/server/mailtexte.ts.
create table if not exists tco.mailtexte (
  schluessel    text primary key,
  betreff       text not null,
  text          text not null,
  geaendert_am  timestamptz not null default now(),
  geaendert_von text not null default ''
);
comment on table tco.mailtexte is 'Eigene E-Mail-Texte des Vereins je Anlass (ohne Zeile: Standardtext)';
select core.enable_audit('tco.mailtexte', 'TCO_MAILTEXT', 'schluessel', '', 'geaendert_am');
