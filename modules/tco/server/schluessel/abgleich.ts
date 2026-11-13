/**
 * Hallenschlüssel (#215): Abgleich mit früheren Kontobewegungen der FI-Belege.
 *
 * Auf zwei wählbaren Konten (Vorgabe: Konten der Hallenprodukte 008/009 – sind sie gleich, dazu das Kassenkonto) werden alle nicht stornierten
 * Buchungen gelesen und den Schlüsselvorgängen gegenübergestellt: bereits verknüpft, Vorschlag (Rechnung, Name im Buchungstext,
 * Betrag = Pfand, Datum), mehrdeutig oder offen. Verknüpfen trägt die FI-Buchung am Vorgang ein (ohne neu zu buchen) und hängt
 * den Paperless-Beleg des Vorgangs an die Buchung; aus einer offenen Buchung lässt sich ein Altfall-Vorgang anlegen.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { dat } from '../format.js';
import { zuidAusAdrnr } from '../kommunikation.js';
import { belegeZuordnen, umsaetzeBuchen } from '../fi/buchen.js';
import { kandidatLesen } from '../halle/sammel.js';
import { bestandAbleiten, cfgLesen, personenAlle, pfandLesen } from './logik.js';
import { ART, abgleichEindeutig, abgleichTreffer, nameImText, type Art } from './regeln.js';
import { protokoll, vorgangAnlegen, type Ich } from './vorgang.js';

export async function abgleichKonten(db: Db): Promise<{ konto1: string; konto2: string; konten: string[]; namen: Record<string, string>; kasse: string }> {
  const cfg = await cfgLesen(db);
  const [c] = await db`select abgleich_konto1, abgleich_konto2 from tco.schluessel_cfg where id = 1`;
  const pfand = await pfandLesen(db);
  const konto1 = (c?.abgleich_konto1 ?? '').trim() || pfand.kontoAusgabe;
  const konto2 = (c?.abgleich_konto2 ?? '').trim() || (pfand.kontoRueckgabe !== konto1 ? pfand.kontoRueckgabe : cfg.kassenkonto);
  const konten = [...new Set([konto1, konto2].filter(Boolean))];
  const namen = Object.fromEntries((await db`select konto, name from tco.fikonten where konto = any(${konten})`).map((r) => [r.konto as string, (r.name ?? '') as string]));
  return { konto1, konto2, konten, namen, kasse: cfg.kassenkonto };
}

export async function abgleichKontenSichern(tx: Db, konto1: string, konto2: string): Promise<string> {
  for (const k of [konto1, konto2]) {
    if (!k) throw new BusinessError('Bitte beide Konten angeben.');
    const [da] = await tx`select 1 from tco.fikonten where konto = ${k}`;
    if (!da) throw new BusinessError(`Konto ${k} ist nicht im Kontenstamm.`);
  }
  await tx`update tco.schluessel_cfg set abgleich_konto1 = ${konto1}, abgleich_konto2 = ${konto2} where id = 1`;
  return `Abgleich auf den Konten ${konto1} und ${konto2}.`;
}

interface Buchung { internenr: string; konto: string; datum: string; text: string; betrag: number; richtung: Art; rgnr: string | null; belnr: string | null; belege: number[] }

/** nicht stornierte Buchungen der Konten; je interner Nummer eine Zeile (das erste Konto gewinnt) */
async function buchungenLesen(db: Db, konten: string[], kasse: string, nur?: string): Promise<Buchung[]> {
  const rows = await db`
    select b.internenr, b.konto, b.datum::text as datum, coalesce(b.text, '') as text, b.soll::float8 as soll, b.haben::float8 as haben, b.rgnr_txt, b.belnr,
           (coalesce(k.kennzahl, '') in ('BA', 'BK') or b.konto = ${kasse}) as geld,
           coalesce((select array_agg(distinct ltrim(p.doknr, '0')::int) from tco.fipapermap p where p.internenr = b.internenr and p.doknr ~ '^[0-9]+$'), '{}') as belege
      from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
     where b.konto = any(${konten}) and b.storno_zu is null and b.datum is not null
       and not exists (select 1 from tco.fibuchungen s where s.storno_zu = b.internenr)
       and (${nur ?? null}::text is null or b.internenr = ${nur ?? null})
     order by b.datum, b.internenr, array_position(${konten}::text[], b.konto), b.posnr`;
  const out = new Map<string, Buchung>();
  for (const r of rows) {
    const soll = Number(r.soll ?? 0), haben = Number(r.haben ?? 0);
    if (!soll && !haben) continue;
    // Geldkonto (Kasse/Bank): Eingang im Soll = Pfand erhalten (Ausgabe); Erlös-/Pfandkonto: Haben = Pfand erhalten
    const eingang = r.geld ? soll > 0 : haben > 0;
    const richtung: Art = eingang ? 'AUSGABE' : 'RUECKGABE';
    if (out.has(r.internenr)) continue;
    out.set(r.internenr, { internenr: r.internenr, konto: r.konto, datum: r.datum, text: r.text, betrag: soll || haben, richtung, rgnr: r.rgnr_txt ?? null, belnr: r.belnr ?? null, belege: r.belege ?? [] });
  }
  return [...out.values()];
}

export async function abgleichLesen(db: Db) {
  const k = await abgleichKonten(db);
  const buchungen = await buchungenLesen(db, k.konten, k.kasse);
  const vorgaenge = (await db`select id, nummer, art, adrnr, person, datum::text as datum, pfand::float8 as pfand, rgnr, internenr, doc_id
                                from tco.schluessel_vorgang where status <> 'STORNIERT' order by datum, id`) as unknown as
    { id: number; nummer: string; art: string; adrnr: string; person: string; datum: string; pfand: number | null; rgnr: string | null; internenr: string | null; doc_id: number | null }[];
  const personen = await personenAlle(db);
  const kurz = (v: typeof vorgaenge[number]) => ({ id: v.id, nummer: v.nummer, person: v.person, datum: v.datum, art_txt: ART[v.art as Art] });
  const frei = vorgaenge.filter((v) => !v.internenr);
  const zeilen = buchungen.map((b) => {
    const verknuepft = vorgaenge.find((v) => v.internenr === b.internenr && v.art === b.richtung);
    const basis = { ...b, richtung_txt: ART[b.richtung], konto_name: k.namen[b.konto] ?? '' };
    if (verknuepft) return { ...basis, status: 'VERKNUEPFT' as const, vorgang: kurz(verknuepft), kandidaten: [], grund: '', person: null };
    const treffer = abgleichTreffer(b, frei);
    const kand = treffer.slice(0, 5).map((t) => ({ ...kurz(frei.find((v) => v.id === t.id)!), grund: t.grund, punkte: t.punkte }));
    if (treffer.length) {
      return { ...basis, status: abgleichEindeutig(treffer) ? 'VORSCHLAG' as const : 'MEHRDEUTIG' as const, vorgang: kand[0], kandidaten: kand, grund: treffer[0].grund, person: null };
    }
    // kein Vorgang: Person aus dem Buchungstext (Vor- und Nachname) – daraus lässt sich ein Altfall anlegen
    const p = personen.filter((x) => nameImText(x.name, b.text) === 2);
    return { ...basis, status: 'OFFEN' as const, vorgang: null, kandidaten: [], grund: '', person: p.length === 1 ? { adrnr: p[0].adrnr, name: p[0].name, info: p[0].info } : null };
  });
  // jeder Vorgang höchstens einmal als eindeutiger Vorschlag (die frühere Buchung gewinnt)
  const vergeben = new Set<number>();
  for (const z of zeilen) {
    if (z.status !== 'VORSCHLAG' || !z.vorgang) continue;
    if (vergeben.has(z.vorgang.id)) (z as { status: string }).status = 'MEHRDEUTIG'; else vergeben.add(z.vorgang.id);
  }
  const gebucht = new Set(vorgaenge.filter((v) => v.internenr).map((v) => v.id));
  return {
    konto1: k.konto1, konto2: k.konto2, namen: k.namen, zeilen,
    /** Vorgänge mit Pfand, zu denen es keine FI-Buchung gibt (und keine Hallenrechnung, über die sie laufen) */
    ohneBuchung: vorgaenge.filter((v) => !gebucht.has(v.id) && !v.rgnr && (v.pfand ?? 0) > 0 && !vergeben.has(v.id)).map(kurz),
    summe: {
      buchungen: zeilen.length, verknuepft: zeilen.filter((z) => z.status === 'VERKNUEPFT').length, vorschlag: zeilen.filter((z) => z.status === 'VORSCHLAG').length,
      mehrdeutig: zeilen.filter((z) => z.status === 'MEHRDEUTIG').length, offen: zeilen.filter((z) => z.status === 'OFFEN').length,
    },
  };
}

async function buchungPruefen(tx: Db, internenr: string): Promise<Buchung[]> {
  const k = await abgleichKonten(tx);
  const b = await buchungenLesen(tx, k.konten, k.kasse, internenr);
  if (!b.length) throw new BusinessError(`Buchung ${internenr} liegt nicht auf den Abgleichskonten oder ist storniert.`);
  return b;
}

/** FI-Buchung an einem Vorgang eintragen (es wird nichts gebucht); der Beleg des Vorgangs wird Beleg der Buchung */
export async function abgleichVerknuepfen(tx: Db, paare: { internenr: string; vorgang_id: number }[], ich: Ich): Promise<string> {
  let n = 0;
  for (const p of paare) {
    const [v] = await tx`select id, nummer, art, status, internenr, doc_id, pfand::float8 as pfand from tco.schluessel_vorgang where id = ${p.vorgang_id} for update`;
    if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
    if (v.status === 'STORNIERT') throw new BusinessError(`${v.nummer} ist storniert.`);
    if (v.internenr && v.internenr !== p.internenr) throw new BusinessError(`${v.nummer} ist bereits mit der FI-Buchung ${v.internenr} verknüpft – bitte zuerst lösen.`);
    const b = (await buchungPruefen(tx, p.internenr)).find((x) => x.richtung === v.art);
    if (!b) throw new BusinessError(`Buchung ${p.internenr} passt nicht zur ${ART[v.art as Art]} ${v.nummer} (Soll/Haben).`);
    const [schon] = await tx`select nummer from tco.schluessel_vorgang where internenr = ${p.internenr} and art = ${v.art} and id <> ${v.id} and status <> 'STORNIERT'`;
    if (schon) throw new BusinessError(`Buchung ${p.internenr} ist bereits mit ${schon.nummer} verknüpft.`);
    await tx`update tco.schluessel_vorgang set internenr = ${p.internenr}, pfand = coalesce(pfand, ${b.betrag}) where id = ${v.id}`;
    if (v.doc_id) await belegeZuordnen(tx, p.internenr, [v.doc_id]);
    await protokoll(tx, v.id, ich, 'BUCHUNG', `Mit FI-Buchung ${p.internenr} vom ${dat(b.datum)} verknüpft (Konto ${b.konto}, ${b.betrag.toFixed(2).replace('.', ',')} €: ${b.text})`);
    n++;
  }
  return `${n} Vorgang/Vorgänge mit FI-Buchungen verknüpft.`;
}

export async function abgleichLoesen(tx: Db, vorgangId: number, ich: Ich): Promise<string> {
  const [v] = await tx`select nummer, internenr from tco.schluessel_vorgang where id = ${vorgangId} for update`;
  if (!v?.internenr) throw new BusinessError('Der Vorgang ist mit keiner FI-Buchung verknüpft.');
  await tx`update tco.schluessel_vorgang set internenr = null where id = ${vorgangId}`;
  await protokoll(tx, vorgangId, ich, 'BUCHUNG', `Verknüpfung zur FI-Buchung ${v.internenr} gelöst`);
  return `Verknüpfung von ${v.nummer} zur FI-Buchung ${v.internenr} gelöst.`;
}

/** Aus einer Buchung ohne Vorgang einen Altfall anlegen (Datum und Pfand aus der Buchung, Beleg der Buchung) */
export async function abgleichAnlegen(tx: Db, internenr: string, richtung: Art, adrnr: string, ich: Ich): Promise<string> {
  const b = (await buchungPruefen(tx, internenr)).find((x) => x.richtung === richtung);
  if (!b) throw new BusinessError(`Buchung ${internenr} hat keine ${ART[richtung]}-Seite auf den Abgleichskonten.`);
  const [schon] = await tx`select nummer from tco.schluessel_vorgang where internenr = ${internenr} and art = ${richtung} and status <> 'STORNIERT'`;
  if (schon) throw new BusinessError(`Buchung ${internenr} ist bereits mit ${schon.nummer} verknüpft.`);
  const k = await kandidatLesen(tx, adrnr.startsWith('99') ? `K:${zuidAusAdrnr(adrnr)}` : `M:${adrnr}`);
  const v = await vorgangAnlegen(tx, {
    art: richtung, adrnr, person: k.name, datum: b.datum, pfand: b.betrag, status: 'QUITTIERT', quittiert_von: 'Altfall – aus FI-Buchung', quittiert_art: 'ALTFALL',
    internenr, doc_id: b.belege[0] ?? null, quelle: 'IMPORT', bemerkung: b.text, angelegt_von: ich.name,
  });
  await protokoll(tx, v.id, ich, 'IMPORT', `Altfall aus FI-Buchung ${internenr} vom ${dat(b.datum)} angelegt (Konto ${b.konto}: ${b.text})`);
  await bestandAbleiten(tx, adrnr);
  return `${ART[richtung]} ${v.nummer} für ${k.name} aus der FI-Buchung ${internenr} angelegt.`;
}

// ---------------------------------------------------------------- historische Ausgaben nachbuchen

export interface NachbuchenEingabe { ids: number[]; ausgegeben_von: string; wert: number; konto: string }

/**
 * Historische Ausgaben ohne Hallenrechnung (Altfälle, Bestand aus dem Mitgliederstamm): Kandidaten für das Nachbuchen.
 * `offen` = noch ohne FI-Buchung – dafür entsteht je Ausgabe eine Buchung auf dem Geldkonto mit dem Gegenkonto der
 * Schlüsselausgabe (Hallenprodukt 008, zum Ausgabedatum). Bereits gebuchte bzw. verknüpfte Ausgaben werden nicht erneut gebucht.
 */
export async function nachbuchenLesen(db: Db, konto: string) {
  const [k] = await db`select konto, name from tco.fikonten where konto = ${konto}`;
  const rows = await db`select id, nummer, person, datum::text as datum, tco_name, pfand::float8 as pfand, internenr, quelle
                          from tco.schluessel_vorgang where art = 'AUSGABE' and status <> 'STORNIERT' and rgnr is null order by datum, id`;
  const zeilen = [];
  for (const r of rows) {
    zeilen.push({
      id: Number(r.id), nummer: r.nummer as string, person: r.person as string, datum: r.datum as string, tco_name: (r.tco_name as string | null) ?? '',
      pfand: (r.pfand as number | null) ?? null, internenr: (r.internenr as string | null) ?? null, offen: !r.internenr,
      gegenkonto: (await pfandLesen(db, r.datum as string)).kontoAusgabe,
    });
  }
  return {
    konto, konto_name: (k?.name as string | undefined) ?? null, konto_fehlt: !k, zeilen,
    mit_rechnung: (await db`select count(*)::int as n from tco.schluessel_vorgang where art = 'AUSGABE' and status <> 'STORNIERT' and rgnr is not null`)[0].n as number,
  };
}

/**
 * Gewählte historische Ausgaben fortschreiben: „ausgegeben von“ überschreiben, Wert (Pfand) setzen und – soweit noch ohne
 * FI-Buchung – je Ausgabe eine FI-Buchung zum Ausgabedatum auf `konto` gegen das Konto der Schlüsselausgabe erzeugen und am
 * Vorgang eintragen (Beleg des Vorgangs wird Beleg der Buchung). Alles oder nichts; abgeschlossene Perioden lehnt die FI ab.
 */
export async function nachbuchen(tx: Db, e: NachbuchenEingabe, ich: Ich): Promise<{ text: string; geaendert: number; buchungen: string[] }> {
  const name = e.ausgegeben_von.trim();
  if (!name) throw new BusinessError('Bitte angeben, wer die Schlüssel ausgegeben hat.');
  if (!(e.wert > 0)) throw new BusinessError('Bitte den Wert des Schlüssels angeben.');
  const [k] = await tx`select 1 from tco.fikonten where konto = ${e.konto}`;
  if (!k) throw new BusinessError(`Konto ${e.konto} ist nicht im Kontenstamm.`);
  const buchungen: string[] = [];
  let n = 0;
  for (const id of [...new Set(e.ids)]) {
    const [v] = await tx`select id, nummer, art, status, rgnr, person, datum::text as datum, tco_name, pfand::float8 as pfand, internenr, doc_id
                           from tco.schluessel_vorgang where id = ${id} for update`;
    if (!v) throw new BusinessError('Vorgang nicht gefunden.', 404);
    if (v.art !== 'AUSGABE' || v.status === 'STORNIERT') throw new BusinessError(`${v.nummer} ist keine gültige Ausgabe.`);
    if (v.rgnr) throw new BusinessError(`${v.nummer} läuft über die Hallenrechnung ${v.rgnr} und wird nicht direkt gebucht.`);
    let internenr = (v.internenr as string | null) ?? null;
    const aenderungen: string[] = [];
    if (((v.tco_name as string | null) ?? '') !== name) aenderungen.push(`ausgegeben von ${name}${v.tco_name ? ` (bisher ${v.tco_name})` : ''}`);
    // bereits gebuchte Ausgaben behalten ihren Wert (er gehört zur vorhandenen Buchung), nur ein fehlender wird ergänzt
    const wert = internenr && v.pfand != null ? Number(v.pfand) : e.wert;
    if (v.pfand == null || Number(v.pfand) !== wert) aenderungen.push(`Wert ${wert.toFixed(2).replace('.', ',')} €`);
    if (!internenr) {
      const gkonto = (await pfandLesen(tx, v.datum as string)).kontoAusgabe;
      const [g] = await umsaetzeBuchen(tx, [{
        konto: e.konto, datum: v.datum as string, text: `Hallenschlüssel Pfand Ausgabe ${v.person}`.slice(0, 60), betrag: wert,
        positionen: [{ gkonto, betrag: wert, text: null, rgnr: null }],
        belege: v.doc_id ? [v.doc_id as number] : [], notiz: `Historische Schlüsselausgabe ${v.nummer} nachgebucht (${ich.name})`,
      }], ich.name);
      internenr = g.internenr;
      buchungen.push(g.internenr);
      aenderungen.push(`FI-Buchung ${g.internenr} (Konto ${e.konto} an ${gkonto})`);
    }
    if (!aenderungen.length) continue;
    await tx`update tco.schluessel_vorgang set tco_name = ${name}, tco_benutzer_id = null, pfand = ${wert}, internenr = ${internenr} where id = ${id}`;
    await protokoll(tx, id, ich, 'BUCHUNG', `Historische Ausgabe fortgeschrieben: ${aenderungen.join(', ')}`);
    n++;
  }
  return { geaendert: n, buchungen, text: `${n} Ausgabe(n) fortgeschrieben${buchungen.length ? `, ${buchungen.length} FI-Buchung(en) auf Konto ${e.konto} angelegt und zugeordnet` : ''}.` };
}
