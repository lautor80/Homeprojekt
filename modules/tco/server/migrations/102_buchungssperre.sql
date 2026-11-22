-- Mahnwesen: Buchungssperre. Das Kennzeichen „buchungssperre“ steht je Stufe in tco.mahn_cfg.stufen (jsonb) –
-- ab dieser Stufe darf ein Mitglied bis zur Zahlung aller angemahnten Posten keine neuen Hallenstunden buchen. Die Sperre
-- selbst wird nicht gespeichert, sondern bei jeder Prüfung aus dem Zahlungsstand ermittelt (Zahlung → automatisch frei).
-- Hier nur die Bestätigung des Hinweises nach der Anmeldung: je Sitzung (Hash des Sitzungstokens) einmal.
create table if not exists tco.buchungssperre_gesehen (
  sitzung      text primary key,
  user_id      uuid not null references core.users (id) on delete cascade,
  posten       text not null default '',          -- bestätigte Rechnungsnummern (Nachweis)
  bestaetigt_am timestamptz not null default now()
);
create index if not exists buchungssperre_gesehen_am on tco.buchungssperre_gesehen (bestaetigt_am);
