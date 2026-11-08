-- ===========================================================================
-- Abrechnung Jugendtraining (Port Z2UI5_CL_TCO_JUGEND_V3 / ZCL_TCO_JT_NACHWEIS)
-- ===========================================================================

-- Steuernummer der Honorartrainer (bisher fest im ABAP-Code) für den Zeitnachweis
alter table tco.mitgliedera add column if not exists steuernummer text;

-- Gesetzliche Feiertage Saarland (in SAP nur im Speicher) neben den Schulferien
alter table tco.ferien add column if not exists feiertag text;

-- n8n-Webhooks (bisher SM59-Destination TCO_N8N_STUNDEN)
alter table tco.verein
  add column if not exists n8n_stunden_url  text,
  add column if not exists n8n_ferien_url   text,
  add column if not exists n8n_stunden_auth text;
select core.enable_audit('tco.verein', 'TCO_VEREIN', 'id', 'paperless_token,n8n_mail_key,n8n_ep3_auth,n8n_stunden_auth', 'updated_at,logo');

-- Änderungsbelege für Trainingszeiten
select core.enable_audit('tco.jrueckm', 'JT_ZEIT', 'adrnr,datum,trainingsart');
create index if not exists jrueckm_datum_idx on tco.jrueckm (datum, adrnr);
