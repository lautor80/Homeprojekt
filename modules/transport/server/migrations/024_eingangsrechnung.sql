-- Posteingang: Eingangsrechnungen prüfen und zerlegen. Doku: docs/euroflex-mailworkflows.md, „Eingangsrechnungen“.
--  teil_von   Teil (Rechnung bzw. Ablieferbelege) eines aufgeteilten PDFs; das Original bleibt als Dokument mit rolle 'original'
--             und Status 'ignoriert' (wird nicht abgelegt) samt Inhalt im Portal
--  rolle      rechnung | ablieferbeleg | transportauftrag | original
--  seiten     Einordnung je Seite: [{ art: R|A|T, sicher, grund }] – Vorschlag für „Aufteilen…“
--  pruefung   Firmierungsprüfung der Rechnung: { ergebnis: ok|alt|unklar, text, alt? }
alter table transport.eing_dokumente
  add column if not exists teil_von bigint references transport.eing_dokumente(id) on delete cascade,
  add column if not exists rolle text check (rolle in ('rechnung', 'ablieferbeleg', 'transportauftrag', 'original')),
  add column if not exists seiten jsonb,
  add column if not exists pruefung jsonb;
create index if not exists eing_dokumente_teil_idx on transport.eing_dokumente (teil_von) where teil_von is not null;

-- Reklamation (Bitte um Rechnungskorrektur) als Entwurf im Postfach angelegt
alter table transport.eing_vorgaenge
  add column if not exists reklamation_am timestamptz,
  add column if not exists reklamation_von text;

-- bekannte frühere Firmierung vorbelegen (Einstellungen → Euroflex → Mail-Workflows → Eingang; dort änderbar)
update transport.workflow_einstellungen
   set eingang = coalesce(eingang, '{}'::jsonb)
                 || jsonb_build_object('fruehereFirmierungen', jsonb_build_array(jsonb_build_object('name', 'Benjamin Hartyniuk Euroflex', 'ustid', 'DE814480003')))
 where id = 1 and not (coalesce(eingang, '{}'::jsonb) ? 'fruehereFirmierungen');
