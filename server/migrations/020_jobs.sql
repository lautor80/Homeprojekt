-- Jobs (Administration → System → Jobs): Funktionen, die als einzelner Lauf ausgeführt werden – nach Plan oder von Hand
-- („Jetzt ausführen“) – mit Protokoll je Lauf. Die Jobs selbst stehen im Quelltext (server/src/jobs-kern.ts und
-- ServerModule.jobs); eine Zeile in core.jobs legt der Server beim Start an (Standardplan), danach gilt, was der
-- Administrator einstellt (Änderungsbeleg, Objekt JOB). Siehe server/src/jobs.ts.
create table if not exists core.jobs (
  id             text primary key,
  eingeplant     boolean not null default true,
  -- { "art": "intervall", "minuten": 60 } oder { "art": "taeglich", "uhrzeit": "02:30", "wochentage": [1,2,3,4,5] }
  plan           jsonb not null,
  -- nächster planmäßiger Start; der Planer beansprucht ihn atomar (update … where naechster_lauf = <gelesen>)
  naechster_lauf timestamptz,
  geaendert_am   timestamptz,
  geaendert_von  text
);
comment on table core.jobs is 'Jobs: Plan je Job (eingeplant, Intervall oder Uhrzeit/Wochentage) und nächster planmäßiger Lauf';
-- naechster_lauf rückt bei jedem Lauf weiter – das ist kein Änderungsbeleg wert
select core.enable_audit('core.jobs', 'JOB', 'id', '', 'naechster_lauf,geaendert_am');

-- Läufe: einer je Ausführung. Läufe ohne Arbeit nach Plan (Status LEER) werden nicht aufbewahrt.
create table if not exists core.job_laeufe (
  id             bigserial primary key,
  job_id         text not null,
  ausloeser      text not null check (ausloeser in ('PLAN', 'MANUELL')),
  gestartet_von  text not null,
  gestartet_am   timestamptz not null default now(),
  beendet_am     timestamptz,
  -- vom laufenden Server fortgeschrieben; älter als 5 Minuten = Server neu gestartet → ABGEBROCHEN
  lebenszeichen  timestamptz not null default now(),
  status         text not null default 'LAEUFT' check (status in ('LAEUFT', 'OK', 'WARNUNG', 'FEHLER', 'ABGEBROCHEN', 'LEER')),
  ergebnis       text,
  -- Abbruch angefordert (Administration → „Abbrechen“); der Server, auf dem der Lauf läuft, prüft das regelmäßig
  abbrechen      boolean not null default false
);
comment on table core.job_laeufe is 'Jobs: Läufe mit Auslöser, Zeiten, Status und Ergebnis (Aufbewahrung 90 Tage)';
create index if not exists job_laeufe_job_idx on core.job_laeufe (job_id, gestartet_am desc);
create index if not exists job_laeufe_gestartet_idx on core.job_laeufe (gestartet_am);
-- höchstens ein Lauf je Job gleichzeitig – auch über mehrere Server-Instanzen hinweg
create unique index if not exists job_laeufe_aktiv_uq on core.job_laeufe (job_id) where status = 'LAEUFT';

create table if not exists core.job_protokoll (
  lauf_id bigint not null references core.job_laeufe(id) on delete cascade,
  nr      integer not null,
  zeit    timestamptz not null,
  stufe   text not null check (stufe in ('info', 'warnung', 'fehler')),
  text    text not null,
  primary key (lauf_id, nr)
);
comment on table core.job_protokoll is 'Jobs: Protokollzeilen je Lauf';
