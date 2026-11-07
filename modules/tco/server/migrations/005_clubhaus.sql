-- ===========================================================================
-- Clubhausabrechnung (Port Z2UI5_CL_TCO_CLUBHAUSABR / ZCL_TCO_CLUBHAUS)
-- ===========================================================================

-- Einstellungen (bisher Konstanten im ABAP-Code)
alter table tco.verein
  add column if not exists ch_konto_einnahmen text not null default '8005',          -- Einzahlungen der Clubhauswirtin
  add column if not exists ch_konto_ware      text not null default '3200',          -- Getränke-Wareneingang (Belege über die FI-Zuordnung)
  add column if not exists ch_reinigung       numeric(9,2) not null default 26,      -- Reinigungspauschale je Montag
  add column if not exists ch_provision       numeric(5,2) not null default 20,      -- Provision in % vom VK
  add column if not exists ch_wirt            text not null default 'Frau Kopp',
  add column if not exists ch_feld_json       text not null default '8';             -- Paperless Custom Field „JSON“ (Getränkebeleg)

create index if not exists werg_datum_idx on tco.werg (datum);
select core.enable_audit('tco.werg', 'GETRAENKERECHNUNG', 'rgnr');
select core.enable_audit('tco.werg_beleg', 'GETRAENKERECHNUNG', 'rgnr');
select core.enable_audit('tco.forderungen', 'CLUBHAUS', 'jahr');
