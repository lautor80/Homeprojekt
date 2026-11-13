/**
 * FI-Belege: Geldkonto bereits gebuchter Belege austauschen (z. B. versehentlich auf 1210 statt 1200 kontiert).
 * Die Buchungen bleiben unverändert bis auf das Konto: die Zeile(n) auf dem bisherigen Geldkonto wandern auf das neue,
 * die Gegenzeilen verweisen auf das neue Konto. Zusammengehörige Stornobuchungen werden mit getauscht.
 *
 * Das ist eine bewusste Ausnahme von „FI-Belege sind unveränderlich“: Für den Tausch werden der Änderungsschutz und der
 * Änderungsbeleg-Trigger der Tabelle nur innerhalb dieser Transaktion abgeschaltet (so gewünscht: kein Änderungsbeleg).
 * Der Periodenschutz bleibt aktiv – Belege in abgeschlossenen Perioden lassen sich nicht umkontieren.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';

export interface TauschKandidat {
  internenr: string; datum: string | null; text: string; betrag: number; gkonten: string[]; storno: boolean; geschlossen: boolean; erfasst_von: string | null;
}

async function kontoPruefen(db: Db, konto: string, geld: boolean): Promise<{ konto: string; name: string }> {
  const [k] = await db`select konto, name, kennzahl from tco.fikonten where konto = ${konto}`;
  if (!k) throw new BusinessError(`Konto ${konto} ist nicht im Kontenstamm.`);
  if (geld && !['BA', 'BK'].includes((k.kennzahl as string | null) ?? '')) throw new BusinessError(`Konto ${konto} ist kein Geldkonto (Kennzahl BA/BK im Kontenstamm).`);
  return { konto: k.konto as string, name: (k.name as string | null) ?? '' };
}

/**
 * Belege, die auf `konto` gebucht sind – optional nur solche mit `gkonto` als Gegenkonto und im Zeitraum.
 * Betrag = Soll − Haben auf dem Konto (Zugang positiv).
 */
export async function tauschKandidaten(db: Db, f: { konto: string; gkonto: string | null; von: string | null; bis: string | null }) {
  const von = await kontoPruefen(db, f.konto, false);
  const rows = await db`
    select b.internenr, min(b.datum)::text as datum, max(coalesce(b.text, '')) as text,
           sum(coalesce(b.soll, 0) - coalesce(b.haben, 0))::float8 as betrag,
           (select array_agg(distinct g.konto order by g.konto) from tco.fibuchungen g where g.internenr = b.internenr and g.konto <> ${f.konto}) as gkonten,
           bool_or(b.storno_zu is not null) or exists (select 1 from tco.fibuchungen s where s.storno_zu = b.internenr) as storno,
           exists (select 1 from tco.fiperioden p where p.jahr = coalesce(min(b.jahr), extract(year from min(b.datum))::int)
                                                   and p.monat = coalesce(min(b.monat), extract(month from min(b.datum))::int)) as geschlossen,
           max(b.erfasst_von) as erfasst_von
      from tco.fibuchungen b
     where b.konto = ${f.konto}
       and (${f.gkonto}::text is null or b.gkonto = ${f.gkonto} or exists (select 1 from tco.fibuchungen g where g.internenr = b.internenr and g.konto = ${f.gkonto}))
       and (${f.von}::date is null or b.datum >= ${f.von}::date) and (${f.bis}::date is null or b.datum <= ${f.bis}::date)
     group by b.internenr order by min(b.datum), b.internenr limit 5001`;
  const zeilen: TauschKandidat[] = rows.slice(0, 5000).map((r) => ({
    internenr: r.internenr as string, datum: (r.datum as string | null) ?? null, text: r.text as string, betrag: Number(r.betrag ?? 0),
    gkonten: (r.gkonten as string[] | null) ?? [], storno: !!r.storno, geschlossen: !!r.geschlossen, erfasst_von: (r.erfasst_von as string | null) ?? null,
  }));
  return { konto: von.konto, konto_name: von.name, zeilen, gekuerzt: rows.length > 5000, summe: Math.round(zeilen.reduce((s, z) => s + z.betrag, 0) * 100) / 100 };
}

/** Geldkonto der gewählten Belege von `von` auf `nach` tauschen; alles oder nichts */
export async function geldkontoTauschen(tx: Db, e: { internenrn: string[]; von: string; nach: string }): Promise<{ text: string; belege: number; zeilen: number }> {
  if (e.von === e.nach) throw new BusinessError('Bisheriges und neues Konto sind gleich.');
  await kontoPruefen(tx, e.von, false);
  const nach = await kontoPruefen(tx, e.nach, true);
  // zusammengehörige Stornobuchungen gehören mit dazu (Ursprung ↔ Storno)
  const partner = await tx`select distinct internenr, storno_zu from tco.fibuchungen
                            where storno_zu is not null and (internenr = any(${e.internenrn}) or storno_zu = any(${e.internenrn}))`;
  const nrn = [...new Set([...e.internenrn, ...partner.flatMap((p) => [p.internenr as string, p.storno_zu as string])])];
  const [da] = await tx`select count(distinct internenr)::int as n from tco.fibuchungen where internenr = any(${nrn}) and konto = ${e.von}`;
  if (da.n < e.internenrn.length) {
    const ok = (await tx`select distinct internenr from tco.fibuchungen where internenr = any(${e.internenrn}) and konto = ${e.von}`).map((r) => r.internenr as string);
    const fehlt = e.internenrn.filter((n) => !ok.includes(n));
    throw new BusinessError(`Nicht (mehr) auf Konto ${e.von} gebucht: Beleg ${fehlt.slice(0, 10).join(', ')} – bitte die Liste neu laden.`, 409);
  }
  // das neue Konto darf im selben Beleg nicht schon mit derselben Position vorkommen (z. B. Umbuchung zwischen beiden Konten)
  const kollision = await tx`select a.internenr from tco.fibuchungen a join tco.fibuchungen b on b.internenr = a.internenr and b.konto = ${e.nach} and b.posnr = a.posnr
                              where a.internenr = any(${nrn}) and a.konto = ${e.von} limit 5`;
  if (kollision.length) throw new BusinessError(`Beleg ${kollision.map((k) => k.internenr).join(', ')} bucht bereits auf beiden Konten (Umbuchung ${e.von} ↔ ${e.nach}) – so nicht tauschbar.`);
  // Ausnahme vom Änderungsschutz, ohne Änderungsbeleg – nur in dieser Transaktion; der Periodenschutz bleibt
  await tx.unsafe('alter table tco.fibuchungen disable trigger fibuchungen_schutz');
  await tx.unsafe('alter table tco.fibuchungen disable trigger zz_audit');
  let r1, r2;
  try {
    r1 = await tx`update tco.fibuchungen set konto = ${e.nach} where internenr = any(${nrn}) and konto = ${e.von}`;
    r2 = await tx`update tco.fibuchungen set gkonto = ${e.nach} where internenr = any(${nrn}) and gkonto = ${e.von}`;
  } catch (err) {
    if ((err as { code?: string }).code === 'FP409') throw new BusinessError(`${(err as Error).message} Bitte die Periode zuerst öffnen (FI-Belege → Perioden) oder die betroffenen Belege abwählen.`, 409);
    throw err;
  }
  await tx.unsafe('alter table tco.fibuchungen enable trigger zz_audit');
  await tx.unsafe('alter table tco.fibuchungen enable trigger fibuchungen_schutz');
  const mit = nrn.length - e.internenrn.length;
  return {
    belege: nrn.length, zeilen: r1.count + r2.count,
    text: `${nrn.length} Beleg(e) von Konto ${e.von} auf ${e.nach} ${nach.name} umkontiert${mit > 0 ? ` (davon ${mit} zugehörige Stornobuchung(en))` : ''}.`,
  };
}
