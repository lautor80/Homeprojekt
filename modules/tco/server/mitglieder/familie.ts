/**
 * Familie: alle Personen, die miteinander verbunden sind – über den abweichenden Zahler (wer am selben Zahler hängt,
 * gehört zusammen, in beide Richtungen) und über die Familienverknüpfung (zwei Personen ohne Zahlungsbezug, z. B.
 * Vater und Mutter mit getrennten Konten). Die Verbindung gilt über mehrere Schritte: Kind → Vater ↔ Mutter → Kind.
 *
 * Die Familie bestimmt, für wen man handeln darf (Vereinskalender: an- und abmelden; „Meine Mitgliedschaft“:
 * Jugendtraining abschließen). Sie ändert nichts an Zahler, Sollstellung und SEPA und gibt keinen Einblick in
 * Verträge oder Bankdaten: die sieht weiterhin nur, wem sie zugeordnet sind.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense } from '../format.js';

/** Adressnummern der ganzen Familie einschließlich der Person selbst – ohne Blick auf Ein- oder Austritt */
export async function familienAdrnrs(db: Db, adrnr: string | null): Promise<string[]> {
  if (!adrnr) return [];
  const rows = await db`
    with recursive kanten as (
      select adrnr as a, adrnrkih as b from tco.mitglieder
       where adrnrkih is not null and ltrim(trim(adrnrkih), '0') <> '' and adrnrkih <> adrnr
      union
      select adrnr_a, adrnr_b from tco.familienverknuepfungen
    ), beide as (
      select a, b from kanten union select b, a from kanten
    ), fam(adrnr) as (
      select ${adrnr}::text
      union
      select k.b from fam f join beide k on k.a = f.adrnr
    )
    select adrnr from fam`;
  return rows.map((r) => r.adrnr as string);
}

/** Personen, die direkt (von Hand) mit dem Mitglied verknüpft sind */
export async function verknuepfteAdrnrs(db: Db, adrnr: string): Promise<string[]> {
  const rows = await db`select case when adrnr_a = ${adrnr} then adrnr_b else adrnr_a end as adrnr
                          from tco.familienverknuepfungen where adrnr_a = ${adrnr} or adrnr_b = ${adrnr}`;
  return rows.map((r) => r.adrnr as string);
}

const paar = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/** zwei Personen zu einer Familie verknüpfen */
export async function familieVerknuepfen(tx: Db, adrnr: string, mit: string, wer: string): Promise<string> {
  if (adrnr === mit) throw new BusinessError('Eine Person lässt sich nicht mit sich selbst verknüpfen.');
  const personen = await tx`select adrnr, vorname, nachname from tco.mitglieder where adrnr = any(${[adrnr, mit]}::text[])`;
  const andere = personen.find((p) => p.adrnr === mit);
  if (!personen.some((p) => p.adrnr === adrnr) || !andere) throw new BusinessError('Die Person existiert nicht.', 404);
  const name = condense(`${andere.vorname ?? ''} ${andere.nachname ?? ''}`) || mit;
  if ((await familienAdrnrs(tx, adrnr)).includes(mit)) throw new BusinessError(`${name} gehört bereits zur Familie.`);
  const [a, b] = paar(adrnr, mit);
  await tx`insert into tco.familienverknuepfungen (adrnr_a, adrnr_b, erstellt_von) values (${a}, ${b}, ${wer})`;
  return `${name} ist jetzt als Familie verknüpft.`;
}

/** Familienverknüpfung lösen – Verbindungen über den Zahler bleiben bestehen */
export async function familieLoesen(tx: Db, adrnr: string, mit: string): Promise<string> {
  const [a, b] = paar(adrnr, mit);
  const weg = await tx`delete from tco.familienverknuepfungen where adrnr_a = ${a} and adrnr_b = ${b} returning id`;
  if (!weg.length) throw new BusinessError('Diese Familienverknüpfung gibt es nicht.', 404);
  return 'Familienverknüpfung gelöst.';
}
