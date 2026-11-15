-- Familienverknüpfung: verbindet zwei Personen zu einer Familie, ohne dass eine über die andere zahlt
-- (z. B. Vater und Mutter mit getrennten Konten, je ein Kind zahlt über einen von beiden). Zusammen mit dem
-- abweichenden Zahler (mitglieder.adrnrkih) ergibt sich daraus die Familie – wer dazugehört, meldet die anderen
-- zu Veranstaltungen an und schließt Jugendtraining für sie ab. Zahler, Sollstellung und SEPA bleiben davon unberührt.
create table if not exists tco.familienverknuepfungen (
  id           serial primary key,
  adrnr_a      text not null,
  adrnr_b      text not null,
  erstellt_am  timestamptz not null default now(),
  erstellt_von text,
  check (adrnr_a < adrnr_b),
  unique (adrnr_a, adrnr_b)
);
create index if not exists familienverknuepfungen_b_idx on tco.familienverknuepfungen (adrnr_b);
select core.enable_audit('tco.familienverknuepfungen', 'MG_FAMILIE', 'id');
