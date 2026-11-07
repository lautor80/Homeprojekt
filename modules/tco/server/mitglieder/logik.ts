import { BusinessError } from '../../../../server/src/errors.js';
import { bicGueltig, ibanGueltig, normalisieren } from '../../../../server/src/lib/sepa.js';
import type { Db } from '../verein.js';
import { condense, dat, heute } from '../format.js';

/**
 * Port von Z2UI5_CL_TCO_MITGLIEDER / ZCL_TCO_MITGLIEDER: Mitgliederliste, Objektseite
 * (Kopf, Bank, Familie, Verträge, SEPA, Schlüssel, Notizen) und Neuanlage.
 */

export const STATUS = ['AKTIV', 'AUSGETRETEN', 'KUNDEN', 'ELTERN', 'ALLE'] as const;
export type Status = (typeof STATUS)[number];
export const DATUM_TYP = ['EINGETRETEN', 'AUSGETRETEN', 'ERFASST'] as const;

export const ZAHLUNGSARTEN: Record<string, string> = { L: 'Lastschrift', U: 'Überweisung', B: 'Bar' };
/** gespeicherter Wert (SAP CHAR10) → Text */
export const ZAHLUNGSWEISEN: Record<string, string> = {
  monatlich: 'monatlich', 'vierteljäh': 'vierteljährlich', 'halbjährli': 'halbjährlich', 'jährlich': 'jährlich',
};
export const ART_JUGEND = '90';

export const leer = (s: unknown) => (s == null ? '' : String(s).trim());
/** Adressverweis (Zahler): leer oder SAP-Initialwert „0000000000“ = kein Verweis */
export const verweis = (s: unknown) => (/^0*$/.test(leer(s)) ? '' : leer(s));
const nr = (adrnr: string) => String(Number(adrnr) || adrnr);

/** Name für Vergleiche: klein, Umlaute/Akzente aufgelöst, ohne Anrede und Sonderzeichen */
export function normName(s: unknown): string {
  let n = leer(s).toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  n = n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/-/g, ' ').replace(/[^a-z ]/g, '');
  n = condense(n);
  if (n.length > 5 && (n.startsWith('herr ') || n.startsWith('frau '))) n = n.slice(5);
  return n;
}

export const istAktiv = (m: { eintritt: string | null; austritt: string | null }) => !!m.eintritt && !m.austritt;
export const geschlechtText = (g: unknown) => (leer(g) === '1' ? 'männlich' : leer(g) === '2' ? 'weiblich' : '');

/** Vertragsbeginn: Mitgliedschaft zum nächsten Halbjahr (1.1./1.7.), Jugendtraining zum Monatsersten; Stichtag zählt selbst */
export function vertragsbeginn(eintritt: string | null | undefined, art: string): string | null {
  if (!eintritt) return null;
  const j = Number(eintritt.slice(0, 4)), m = Number(eintritt.slice(5, 7)), t = eintritt.slice(8, 10);
  if (leer(art) === ART_JUGEND) {
    if (t === '01') return eintritt;
    return m === 12 ? `${j + 1}-01-01` : `${j}-${String(m + 1).padStart(2, '0')}-01`;
  }
  const md = eintritt.slice(5);
  if (md === '01-01' || md === '07-01') return eintritt;
  return m <= 6 ? `${j}-07-01` : `${j + 1}-01-01`;
}

const mandatAktiv = (s: { status: string | null; gueltigbis: string | null; manuell_aktiv?: boolean } | null | undefined) =>
  !!s && (s.manuell_aktiv || (leer(s.status) === 'X' && (!s.gueltigbis || s.gueltigbis >= heute())));

// ---------------------------------------------------------------- Liste
export interface ListZeile {
  adrnr: string; name: string; mitglnrn: string; info: string; ort: string; eintritt: string | null; austritt: string | null;
  status_txt: string; state: 'Positive' | 'Negative' | 'Critical'; kunde: boolean; eltern: boolean; zahler: boolean;
}

export async function listeLesen(db: Db, f: { status: Status; datumTyp?: string; von?: string | null; bis?: string | null; suche?: string | null }) {
  const alle = await db`select m.adrnr, m.vorname, m.nachname, m.mitglnrn, m.plz, m.ort, m.eintritt, m.austritt, m.geburtsdatum, m.adrnrkih,
                               coalesce(a.zuid, '') <> '' as kunde,
                               exists (select 1 from tco.mitglieder k where k.adrnr <> m.adrnr and k.adrnrkih = m.adrnr) as eltern
                          from tco.mitglieder m left join tco.mitgliedera a on a.adrnr = m.adrnr
                         order by lower(m.nachname), lower(m.vorname), m.adrnr`;
  const anzahl: Record<Status, number> = { AKTIV: 0, AUSGETRETEN: 0, KUNDEN: 0, ELTERN: 0, ALLE: alle.length };
  const passt = (m: (typeof alle)[number], s: Status) =>
    s === 'AKTIV' ? istAktiv(m as never) : s === 'AUSGETRETEN' ? !!m.austritt : s === 'KUNDEN' ? m.kunde : s === 'ELTERN' ? m.eltern : true;
  for (const m of alle) for (const s of ['AKTIV', 'AUSGETRETEN', 'KUNDEN', 'ELTERN'] as const) if (passt(m, s)) anzahl[s]++;
  const such = leer(f.suche).toUpperCase();
  const zeilen: ListZeile[] = [];
  for (const m of alle) {
    if (!passt(m, f.status)) continue;
    if (f.von || f.bis) {
      const pr = f.datumTyp === 'AUSGETRETEN' ? m.austritt : f.datumTyp === 'ERFASST' ? (m.eintritt ?? m.geburtsdatum) : m.eintritt;
      if (!pr || (f.von && pr < f.von) || (f.bis && pr > f.bis)) continue;
    }
    const name = condense(`${leer(m.nachname)}, ${leer(m.vorname)}`).replace(/^, |, $/g, '');
    if (such && !name.toUpperCase().includes(such) && !leer(m.mitglnrn).toUpperCase().includes(such)) continue;
    const aktiv = istAktiv(m as never);
    const ort = condense(`${leer(m.plz)} ${leer(m.ort)}`);
    zeilen.push({
      adrnr: m.adrnr, name, mitglnrn: leer(m.mitglnrn), ort, eintritt: m.eintritt, austritt: m.austritt, kunde: m.kunde, eltern: m.eltern,
      zahler: !leer(m.mitglnrn),
      info: leer(m.mitglnrn) ? (ort ? `${leer(m.mitglnrn)} · ${ort}` : `Mitglied ${leer(m.mitglnrn)}`) : (ort ? `Zahler · ${ort}` : 'Zahler'),
      status_txt: aktiv ? 'Aktiv' : m.austritt ? `Austritt ${dat(m.austritt)}` : 'Ohne Eintritt',
      state: aktiv ? 'Positive' : m.austritt ? 'Negative' : 'Critical',
    });
  }
  return { zeilen, anzahl };
}

// ---------------------------------------------------------------- Detail
export async function mitgliedLesen(db: Db, adrnr: string) {
  const [m] = await db`select * from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) throw new BusinessError(`Mitglied ${nr(adrnr)} nicht gefunden.`);
  return m;
}

/** Kontoinhaber ohne Anrede; passt der Freitext zum verknüpften Zahler, gilt dessen Stammname */
export async function kontoinhaberText(db: Db, freitext: string | null, adrnrkih: string | null): Promise<string> {
  const t = leer(freitext).replace(/^(Frau|Herr)\s+/i, '').trim();
  if (!adrnrkih) return t;
  const [z] = await db`select vorname, nachname from tco.mitglieder where adrnr = ${adrnrkih}`;
  if (!z) return t;
  const stamm = condense(`${leer(z.vorname)} ${leer(z.nachname)}`);
  if (!t) return stamm;
  const n = normName(t);
  return n === normName(stamm) || n === normName(`${leer(z.nachname)} ${leer(z.vorname)}`) ? stamm : t;
}

/** Mandatsreferenz: eigene → die des Zahlers → jüngstes aktives Mandat des Zahlers */
export async function mandatsref(db: Db, adrnr: string): Promise<string> {
  const [m] = await db`select mandatsrefenz, adrnrkih from tco.mitglieder where adrnr = ${adrnr}`;
  if (!m) return '';
  if (leer(m.mandatsrefenz)) return leer(m.mandatsrefenz);
  const z = verweis(m.adrnrkih) || adrnr;
  const [zm] = await db`select mandatsrefenz from tco.mitglieder where adrnr = ${z}`;
  if (leer(zm?.mandatsrefenz)) return leer(zm.mandatsrefenz);
  const s = await db`select mandatsnr, status, gueltigbis, manuell_aktiv from tco.sepa where adrnr in ${db([z, adrnr])} order by angelegtam desc nulls last`;
  return leer(s.find((x) => mandatAktiv(x as never))?.mandatsnr);
}

export interface Person { adrnr: string; name: string; mitglnrn: string; geburtsdatum: string | null; eintritt: string | null; austritt: string | null; rolle: string }

/** Mitglied, abweichender Zahler und alle (nicht ausgetretenen) Personen mit demselben Zahler bzw. diesem Mitglied als Zahler */
export async function familieLesen(db: Db, m: Record<string, any>): Promise<Person[]> {
  const kopf = verweis(m.adrnrkih) || m.adrnr;
  const rows = await db`select adrnr, vorname, nachname, mitglnrn, geburtsdatum, eintritt, austritt, adrnrkih from tco.mitglieder
                         where adrnr = ${kopf} or adrnr = ${m.adrnr}
                            or (austritt is null and (adrnrkih = ${kopf} or adrnrkih = ${m.adrnr}))`;
  const p: Person[] = rows.map((r) => ({
    adrnr: r.adrnr, name: condense(`${leer(r.vorname)} ${leer(r.nachname)}`), mitglnrn: leer(r.mitglnrn), geburtsdatum: r.geburtsdatum,
    eintritt: r.eintritt, austritt: r.austritt,
    rolle: r.adrnr === m.adrnr ? 'Mitglied' : r.adrnr === verweis(m.adrnrkih) ? 'Abweichender Zahler' : r.adrnrkih === m.adrnr ? 'Zahlt über dieses Mitglied' : 'Familienmitglied',
  }));
  const rang = (x: Person) => (x.adrnr === m.adrnr ? 0 : x.rolle === 'Abweichender Zahler' ? 1 : 2);
  return p.sort((a, b) => rang(a) - rang(b) || (a.geburtsdatum ?? '').localeCompare(b.geburtsdatum ?? ''));
}

export interface Vertrag {
  adrnr: string; person: string; vertragnr: string; art: string; artname: string; sollstellung: string; vertragbegin: string | null;
  vertragende: string | null; betrag: number; zahler_adrnr: string; zahler: string; laeuft: boolean; eigen: boolean;
}

/** Verträge des Mitglieds und der Personen, die über dieses Mitglied zahlen */
export async function vertraegeLesen(db: Db, m: Record<string, any>): Promise<Vertrag[]> {
  const rows = await db`select v.*, p.vorname, p.nachname, p.geburtsdatum, z.vorname as z_vorname, z.nachname as z_nachname,
                               k.vorname as k_vorname, k.nachname as k_nachname
                          from tco.vertraege v join tco.mitglieder p on p.adrnr = v.adrnr
                          left join tco.mitglieder z on z.adrnr = v.zahler_adrnr and z.adrnr <> v.adrnr and ltrim(v.zahler_adrnr, '0') <> ''
                          left join tco.mitglieder k on k.adrnr = p.adrnrkih and k.adrnr <> p.adrnr and ltrim(p.adrnrkih, '0') <> ''
                         where v.adrnr = ${m.adrnr} or (p.adrnrkih = ${m.adrnr} and p.adrnr <> ${m.adrnr})`;
  const h = heute();
  return rows.map((v) => ({
    adrnr: v.adrnr, person: condense(`${leer(v.vorname)} ${leer(v.nachname)}`), vertragnr: leer(v.vertragnr), art: leer(v.art),
    artname: leer(v.artname), sollstellung: leer(v.sollstellung), vertragbegin: v.vertragbegin, vertragende: v.vertragende,
    // Zahler am Vertrag = Mitglied selbst gilt wie „kein abweichender Zahler“ (wie in der Sollstellung)
    betrag: Number(v.betrag ?? 0), zahler_adrnr: verweis(v.zahler_adrnr) === v.adrnr ? '' : verweis(v.zahler_adrnr),
    zahler: verweis(v.zahler_adrnr) && verweis(v.zahler_adrnr) !== v.adrnr
      ? (v.z_nachname != null ? condense(`${leer(v.z_nachname)}, ${leer(v.z_vorname)}`) : `${Number(v.zahler_adrnr) || v.zahler_adrnr} (nicht gefunden)`)
      : v.k_nachname != null ? `wie Mitglied (${condense(`${leer(v.k_nachname)}, ${leer(v.k_vorname)}`)})` : 'wie Mitglied',
    laeuft: !v.vertragende || v.vertragende >= h, eigen: v.adrnr === m.adrnr, _geb: v.geburtsdatum,
  }) as Vertrag & { _geb: string | null })
    .sort((a, b) => Number(!a.eigen) - Number(!b.eigen) || (a._geb ?? '').localeCompare(b._geb ?? '') || a.adrnr.localeCompare(b.adrnr)
      || (Number(a.vertragnr) || 0) - (Number(b.vertragnr) || 0))
    .map(({ _geb, ...v }) => v);
}

export async function sepaLesen(db: Db, m: Record<string, any>) {
  const ids = [...new Set([m.adrnr, verweis(m.adrnrkih)].filter(Boolean))];
  const rows = await db`select s.*, p.vorname, p.nachname, p.austritt from tco.sepa s join tco.mitglieder p on p.adrnr = s.adrnr
                         where s.adrnr in ${db(ids)} order by s.angelegtam desc nulls last`;
  return rows.map((s) => ({
    adrnr: s.adrnr, inhaber: condense(`${leer(s.vorname)} ${leer(s.nachname)}`), mandatsnr: leer(s.mandatsnr), lastschriftart: leer(s.lastschriftart),
    typ: leer(s.typ) === 'W' ? 'Wiederkehrend' : leer(s.typ) === 'E' ? 'Einmalig' : leer(s.typ), angelegtam: s.angelegtam, gueltigbis: s.gueltigbis,
    status: leer(s.status), manuell_aktiv: s.manuell_aktiv, aktiv: mandatAktiv(s as never), austritt: s.austritt, eigen: s.adrnr === m.adrnr,
  }));
}

export async function detailLesen(db: Db, adrnr: string) {
  const m = await mitgliedLesen(db, adrnr);
  const [a] = await db`select trainer, zuid, steuernummer from tco.mitgliedera where adrnr = ${adrnr}`;
  const [z] = verweis(m.adrnrkih) ? await db`select adrnr, vorname, nachname, austritt, iban1 from tco.mitglieder where adrnr = ${m.adrnrkih}` : [];
  const [k] = await db`select kanal from tco.kommpref where adrnr = ${adrnr}`;
  const schluessel = await db`select counter, ausgabe, ausgabebeleg, ruecknahme, ruecknahmebeleg from tco.schluessel where adrnr = ${adrnr} order by counter`;
  const notizen = await db`select notiz_id, erstellt_am, erstellt_von, notiz from tco.mgnotiz where adrnr = ${adrnr} order by erstellt_am desc`;
  return {
    mitglied: {
      adrnr: m.adrnr, anrede: leer(m.anrede), vorname: leer(m.vorname), nachname: leer(m.nachname), strasse: leer(m.strasse), plz: leer(m.plz),
      ort: leer(m.ort), telefon: leer(m.telefon), mobil: leer(m.telefon6), email: leer(m.email), geburtsdatum: m.geburtsdatum,
      geschlecht: leer(m.geschlecht), geschlecht_txt: geschlechtText(m.geschlecht), eintritt: m.eintritt, austritt: m.austritt,
      mitglnrn: leer(m.mitglnrn), datenschutz: leer(m.checkbox1) === 'J', bildrechte: leer(m.checkbox2) === 'J',
      aktiv: istAktiv(m as never),
    },
    titel: condense(`${leer(m.nachname)} ${leer(m.vorname)}`),
    bank: {
      zahlungsart: leer(m.zahlungsart), zahlungsart_txt: ZAHLUNGSARTEN[leer(m.zahlungsart)] ?? leer(m.zahlungsart),
      zahlungsweise: leer(m.zahlungsweise), zahlungsweise_txt: ZAHLUNGSWEISEN[leer(m.zahlungsweise)] ?? leer(m.zahlungsweise),
      iban: leer(m.iban1), bic: leer(m.bic1), bank: leer(m.bank1), abwkontoinh: leer(m.abwkontoinh), adrnrkih: verweis(m.adrnrkih),
      kontoinhaber: (await kontoinhaberText(db, m.abwkontoinh, verweis(m.adrnrkih) || null)) || condense(`${leer(m.vorname)} ${leer(m.nachname)}`),
      zahler: z ? { adrnr: z.adrnr, name: condense(`${leer(z.nachname)}, ${leer(z.vorname)}`), austritt: z.austritt, iban: leer(z.iban1) } : null,
      mandatsref: await mandatsref(db, adrnr),
    },
    trainer: !!a?.trainer, zuid: leer(a?.zuid), kanal: leer(k?.kanal),
    familie: await familieLesen(db, m),
    vertraege: await vertraegeLesen(db, m),
    sepa: await sepaLesen(db, m),
    schluessel, notizen,
  };
}

// ---------------------------------------------------------------- Kopf / Bank / Austritt
export interface Kopf {
  anrede: string; vorname: string; nachname: string; strasse: string; plz: string; ort: string; telefon: string; mobil: string; email: string;
  geburtsdatum: string | null; eintritt: string | null; datenschutz: boolean; bildrechte: boolean;
}

export const emailGueltig = (e: string) => !e || /^[^@ ]+@[^@ ]+\.[^@ ]+$/.test(e);

export async function kopfSichern(tx: Db, adrnr: string, k: Kopf) {
  const m = await mitgliedLesen(tx, adrnr);
  if (!condense(k.nachname)) throw new BusinessError('Bitte einen Nachnamen angeben.');
  if (!emailGueltig(k.email.trim())) throw new BusinessError('Die E-Mail-Adresse ist ungültig.');
  if (m.austritt && k.eintritt && m.austritt < k.eintritt) throw new BusinessError(`Der Eintritt liegt nach dem Austritt am ${dat(m.austritt)}.`);
  const nn = condense(k.nachname);
  await tx`update tco.mitglieder set anrede = ${k.anrede || null}, vorname = ${condense(k.vorname) || null}, nachname = ${nn},
             alphabet = ${nn.slice(0, 1).toUpperCase()}, strasse = ${condense(k.strasse) || null}, plz = ${condense(k.plz) || null},
             ort = ${condense(k.ort) || null}, telefon = ${condense(k.telefon) || null}, telefon6 = ${condense(k.mobil) || null},
             email = ${k.email.trim() || null}, geburtsdatum = ${k.geburtsdatum || null}, eintritt = ${k.eintritt || null},
             geschlecht = ${k.anrede === 'Herr' ? '1' : k.anrede === 'Frau' ? '2' : m.geschlecht},
             checkbox1 = ${k.datenschutz ? 'J' : 'N'}, checkbox2 = ${k.bildrechte ? 'J' : 'N'}
           where adrnr = ${adrnr}`;
}

export interface Bank { zahlungsart: string; zahlungsweise: string; iban: string; bic: string; bank: string; abwkontoinh: string; adrnrkih: string }

export async function bankSichern(tx: Db, adrnr: string, b: Bank) {
  await mitgliedLesen(tx, adrnr);
  if (!ZAHLUNGSARTEN[b.zahlungsart]) throw new BusinessError('Bitte eine Zahlungsart wählen.');
  const iban = normalisieren(b.iban), bic = normalisieren(b.bic);
  if (b.zahlungsart === 'L' && !iban) throw new BusinessError('Für die Lastschrift wird eine IBAN benötigt.');
  if (iban && !ibanGueltig(iban)) throw new BusinessError('Die IBAN ist ungültig (Prüfziffer/Länge).');
  if (bic && (![8, 11].includes(bic.length) || !bicGueltig(bic))) throw new BusinessError('Die BIC muss 8 oder 11 Zeichen lang sein.');
  let kih = leer(b.adrnrkih);
  if (kih === adrnr) kih = '';
  if (kih) {
    const [z] = await tx`select austritt from tco.mitglieder where adrnr = ${kih}`;
    if (!z) throw new BusinessError('Der gewählte Zahler existiert nicht.');
  }
  await tx`update tco.mitglieder set zahlungsart = ${b.zahlungsart}, zahlungsweise = ${b.zahlungsweise || null}, iban1 = ${iban || null},
             bic1 = ${bic || null}, bank1 = ${condense(b.bank) || null}, abwkontoinh = ${condense(b.abwkontoinh) || null}, adrnrkih = ${kih || null}
           where adrnr = ${adrnr}`;
}

/** Mögliche Zahler: alle nicht ausgetretenen Personen außer dem Mitglied selbst */
export async function zahlerAuswahl(db: Db, ohne?: string) {
  const rows = await db`select adrnr, vorname, nachname, plz, ort, mitglnrn, iban1 from tco.mitglieder
                         where austritt is null and adrnr <> ${ohne ?? ''} order by lower(nachname), lower(vorname)`;
  return rows.filter((p) => condense(`${leer(p.nachname)} ${leer(p.vorname)}`)).map((p) => {
    let t = condense(`${leer(p.nachname)} ${leer(p.vorname)}`);
    if (leer(p.ort)) t += `, ${condense(`${leer(p.plz)} ${leer(p.ort)}`)}`;
    if (!leer(p.mitglnrn)) t += ' (Zahler)';
    if (!leer(p.iban1)) t += ' – ohne IBAN';
    return { adrnr: p.adrnr as string, text: t, iban: leer(p.iban1) };
  });
}

/** SEPA-Mandate an den Austritt anpassen (wie SEPA_ENDE_SETZEN); manuell aktivierte bleiben unberührt */
export async function sepaEndeSetzen(tx: Db, adrnr: string, austrittAlt: string | null = null): Promise<string | null> {
  const [m] = await tx`select austritt from tco.mitglieder where adrnr = ${adrnr}`;
  if (m?.austritt) {
    await tx`update tco.sepa set gueltigbis = ${m.austritt} where adrnr = ${adrnr} and not manuell_aktiv`;
    await tx`update tco.sepa set status = null where status = 'X' and gueltigbis is not null and gueltigbis < current_date and not manuell_aktiv`;
    return m.austritt;
  }
  if (austrittAlt) await tx`update tco.sepa set gueltigbis = null, status = 'X' where adrnr = ${adrnr} and gueltigbis = ${austrittAlt}`;
  return null;
}

export async function austrittSichern(tx: Db, adrnr: string, austritt: string | null): Promise<string> {
  const m = await mitgliedLesen(tx, adrnr);
  if ((m.austritt ?? null) === (austritt ?? null)) return 'Keine Änderung.';
  if (austritt && m.eintritt && austritt < m.eintritt) throw new BusinessError(`Der Austritt liegt vor dem Eintritt am ${dat(m.eintritt)}.`);
  await tx`update tco.mitglieder set austritt = ${austritt} where adrnr = ${adrnr}`;
  const ende = await sepaEndeSetzen(tx, adrnr, m.austritt);
  return austritt ? `Austritt ${dat(austritt)} gesichert – SEPA-Mandat gültig bis ${dat(ende)}.` : 'Austritt entfernt – SEPA-Mandat wieder aktiv und unbefristet.';
}

/** Mandat eines ausgetretenen Zahlers manuell wieder aktivieren (z. B. Kinder zahlen weiter über ihn) bzw. zurücksetzen */
export async function sepaManuell(tx: Db, adrnr: string, aktiv: boolean): Promise<string> {
  const [s] = await tx`select * from tco.sepa where adrnr = ${adrnr}`;
  if (!s) throw new BusinessError('Für diese Person gibt es kein SEPA-Mandat.');
  if (aktiv) {
    await tx`update tco.sepa set manuell_aktiv = true, status = 'X', gueltigbis = null where adrnr = ${adrnr}`;
    return `SEPA-Mandat ${leer(s.mandatsnr)} manuell aktiviert.`;
  }
  await tx`update tco.sepa set manuell_aktiv = false where adrnr = ${adrnr}`;
  await sepaEndeSetzen(tx, adrnr);
  return `Manuelle Aktivierung von ${leer(s.mandatsnr)} aufgehoben.`;
}

export async function trainerSetzen(tx: Db, adrnr: string, trainer: boolean) {
  await mitgliedLesen(tx, adrnr);
  await tx`insert into tco.mitgliedera (adrnr, trainer) values (${adrnr}, ${trainer}) on conflict (adrnr) do update set trainer = excluded.trainer`;
}

export async function kanalSetzen(tx: Db, adrnr: string, kanal: 'E' | 'W' | '', benutzer: string) {
  if (!kanal) await tx`delete from tco.kommpref where adrnr = ${adrnr}`;
  else await tx`insert into tco.kommpref (adrnr, kanal, geaendert_am, geaendert_von) values (${adrnr}, ${kanal}, current_date, ${benutzer})
                on conflict (adrnr) do update set kanal = excluded.kanal, geaendert_am = excluded.geaendert_am, geaendert_von = excluded.geaendert_von`;
}

// ---------------------------------------------------------------- Schlüssel / Notizen
export async function schluesselSetzen(tx: Db, adrnr: string, s: { ausgabe: string | null; ausgabebeleg: string; ruecknahme: string | null; ruecknahmebeleg: string }) {
  await mitgliedLesen(tx, adrnr);
  if (s.ausgabe && s.ruecknahme && s.ruecknahme < s.ausgabe) throw new BusinessError('Die Rückgabe liegt vor der Ausgabe.');
  if (!s.ausgabe && !s.ruecknahme) { await tx`delete from tco.schluessel where adrnr = ${adrnr}`; return; }
  await tx`insert into tco.schluessel (adrnr, counter, ausgabe, ausgabebeleg, ruecknahme, ruecknahmebeleg)
           values (${adrnr}, '1', ${s.ausgabe}, ${condense(s.ausgabebeleg) || null}, ${s.ruecknahme}, ${condense(s.ruecknahmebeleg) || null})
           on conflict (adrnr) do update set ausgabe = excluded.ausgabe, ausgabebeleg = excluded.ausgabebeleg,
             ruecknahme = excluded.ruecknahme, ruecknahmebeleg = excluded.ruecknahmebeleg`;
}

export async function notizAnlegen(tx: Db, adrnr: string, text: string, benutzer: string) {
  await mitgliedLesen(tx, adrnr);
  if (!text.trim()) throw new BusinessError('Bitte einen Text eingeben.');
  await tx`insert into tco.mgnotiz (adrnr, erstellt_von, notiz) values (${adrnr}, ${benutzer}, ${text.trim()})`;
}

export async function notizLoeschen(tx: Db, adrnr: string, id: string) {
  const r = await tx`delete from tco.mgnotiz where adrnr = ${adrnr} and notiz_id = ${id}`;
  if (!r.count) throw new BusinessError('Die Notiz ist nicht mehr vorhanden.');
}

// ---------------------------------------------------------------- Verträge
export interface VertragsArt { art: string; name: string; betrag: number; turnus: string }

/** Vertragsarten aus dem Bestand (jüngster Vertrag je Art), gefiltert auf aktive Beitragsarten; Betrag aus dem Beitragsstamm */
export async function vertragsarten(db: Db, stichtag = heute()): Promise<{ arten: VertragsArt[]; turnusse: string[] }> {
  const v = await db`select distinct on (art) art, artname, sollstellung, betrag from tco.vertraege
                      where coalesce(art, '') <> '' order by art, vertragbegin desc nulls last`;
  const turnusse = [...new Set((await db`select distinct sollstellung from tco.vertraege where coalesce(sollstellung, '') <> ''`).map((x) => leer(x.sollstellung)))].sort();
  const stamm = await db`select b.art, b.bezeichnung, b.turnus, b.aktiv,
                                (select p.betrag from tco.beitrag_pr p where p.art = b.art and p.gueltig_ab <= ${stichtag}
                                   and (p.gueltig_bis is null or p.gueltig_bis >= ${stichtag}) order by p.gueltig_ab desc limit 1) as betrag
                           from tco.beitrag b`;
  const st = new Map(stamm.map((s) => [leer(s.art), s]));
  const arten = new Map<string, VertragsArt>();
  for (const x of v) arten.set(leer(x.art), { art: leer(x.art), name: leer(x.artname), betrag: Number(x.betrag ?? 0), turnus: leer(x.sollstellung) });
  for (const s of stamm) if (!arten.has(leer(s.art))) arten.set(leer(s.art), { art: leer(s.art), name: leer(s.bezeichnung), betrag: 0, turnus: leer(s.turnus) });
  let liste = [...arten.values()];
  if (stamm.length) liste = liste.filter((a) => st.get(a.art)?.aktiv);
  for (const a of liste) {
    const s = st.get(a.art);
    if (s) {
      if (s.bezeichnung) a.name = leer(s.bezeichnung);
      if (s.turnus) a.turnus = leer(s.turnus);
      if (s.betrag != null) a.betrag = Number(s.betrag);
    }
    if (a.turnus && !turnusse.includes(a.turnus)) turnusse.push(a.turnus);
  }
  liste.sort((a, b) => (Number(a.art) || 999999) - (Number(b.art) || 999999) || a.art.localeCompare(b.art));
  return { arten: liste, turnusse: turnusse.sort() };
}

/** Betrag laut Beitragsstamm am Stichtag, sonst null */
export async function betragAm(db: Db, art: string, datum: string): Promise<number | null> {
  const [p] = await db`select betrag from tco.beitrag_pr where art = ${art} and gueltig_ab <= ${datum}
                        and (gueltig_bis is null or gueltig_bis >= ${datum}) order by gueltig_ab desc limit 1`;
  return p ? Number(p.betrag) : null;
}

/** Abweichende Zahler je Vertrag: Personen mit aktivem, gültigem SEPA-Mandat */
export async function vertragsZahler(db: Db) {
  const rows = await db`select m.adrnr, m.vorname, m.nachname, m.iban1, s.status, s.gueltigbis, s.manuell_aktiv
                          from tco.sepa s join tco.mitglieder m on m.adrnr = s.adrnr order by lower(m.nachname), lower(m.vorname)`;
  return rows.filter((r) => mandatAktiv(r as never)).map((r) => {
    const iban = leer(r.iban1);
    return { adrnr: r.adrnr as string, text: condense(`${leer(r.nachname)}, ${leer(r.vorname)}${iban.length > 4 ? ` (IBAN …${iban.slice(-4)})` : ''}`) };
  });
}

export async function vertragNeu(tx: Db, b: { adrnr: string; art: string; beginn: string; ende?: string | null; turnus: string; betrag: number; zahler?: string | null }) {
  const p = await mitgliedLesen(tx, b.adrnr);
  const { arten } = await vertragsarten(tx, b.beginn);
  const a = arten.find((x) => x.art === b.art);
  if (!a) throw new BusinessError(`Die Vertragsart ${b.art} ist nicht (mehr) aktiv.`);
  if (!b.turnus) throw new BusinessError('Bitte einen Turnus wählen.');
  if (b.ende && b.ende < b.beginn) throw new BusinessError('Das Laufzeitende liegt vor dem Vertragsbeginn.');
  if (!(b.betrag >= 0)) throw new BusinessError('Der Betrag ist ungültig.');
  let zahler = leer(b.zahler);
  if (zahler === b.adrnr) zahler = '';
  if (zahler && !(await vertragsZahler(tx)).some((z) => z.adrnr === zahler)) throw new BusinessError('Der Zahler hat kein aktives SEPA-Mandat.');
  const [mx] = await tx`select coalesce(max(vertragnr::int), 0) as n from tco.vertraege where adrnr = ${b.adrnr} and vertragnr ~ '^[0-9]+$'`;
  const vnr = String(Number(mx.n) + 1);
  await tx`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, vertragende, betrag, zahler_adrnr)
           values (${b.adrnr}, ${vnr}, ${a.art}, ${a.name}, ${leer(p.mitglnrn) || null}, ${b.turnus}, ${b.beginn}, ${b.ende || null}, ${b.betrag}, ${zahler || null})`;
  return vnr;
}

export async function vertragAendern(tx: Db, adrnr: string, vertragnr: string, b: { ende?: string | null; zahler?: string | null }): Promise<string> {
  const [v] = await tx`select * from tco.vertraege where adrnr = ${adrnr} and vertragnr = ${vertragnr}`;
  if (!v) throw new BusinessError(`Vertrag ${vertragnr}: Vertrag nicht mehr vorhanden.`);
  const texte: string[] = [];
  if (b.ende !== undefined && (b.ende || null) !== (v.vertragende ?? null)) {
    if (b.ende && v.vertragbegin && b.ende < v.vertragbegin) throw new BusinessError(`Vertrag ${vertragnr}: Laufzeitende liegt vor dem Vertragsbeginn ${dat(v.vertragbegin)}.`);
    await tx`update tco.vertraege set vertragende = ${b.ende || null} where adrnr = ${adrnr} and vertragnr = ${vertragnr}`;
    await sepaEndeSetzen(tx, adrnr);
    texte.push(b.ende ? `Laufzeitende ${dat(b.ende)} gesichert` : 'unbefristet gesichert');
  }
  if (b.zahler !== undefined) {
    let z = leer(b.zahler);
    if (z === adrnr) z = '';
    if (z !== verweis(v.zahler_adrnr)) {
      if (z && !(await vertragsZahler(tx)).some((x) => x.adrnr === z)) throw new BusinessError('Der Zahler hat kein aktives SEPA-Mandat.');
      await tx`update tco.vertraege set zahler_adrnr = ${z || null} where adrnr = ${adrnr} and vertragnr = ${vertragnr}`;
      texte.push(z ? 'Zahler gesichert (ab nächster Sollstellung)' : 'Zahler wie Mitglied gesichert');
    }
  }
  return texte.length ? `Vertrag ${vertragnr}: ${texte.join(', ')}.` : 'Keine Änderung.';
}

// ---------------------------------------------------------------- Neuanlage
export interface Neu extends Omit<Kopf, 'eintritt'> {
  eintritt: string;
  zahlungsart: string; zahlungsweise: string; iban: string; bic: string; bank: string;
  sepa: boolean; sepa_datum: string | null;
  zahler_modus: 'SELBST' | 'BESTEHEND' | 'NEU'; zahler_adrnr: string | null;
  z_anrede: string; z_vorname: string; z_nachname: string; z_strasse: string; z_plz: string; z_ort: string; z_email: string;
  vertraege: { art: string; beginn: string | null; betrag: number; turnus: string }[];
}

const adrNummer = (n: number) => String(n).padStart(10, '0');

/** SEPA-Mandat für den Zahler: aktives weiterverwenden, sonst MANDKEY = Basis & Zähler, MANDATSNR = MANDKEY & '1' */
export async function sepaAnlegen(tx: Db, zahler: string, basis: string, datum: string): Promise<{ mandatsnr: string; neu: boolean }> {
  const [alt] = await tx`select * from tco.sepa where adrnr = ${zahler}`;
  if (alt && mandatAktiv(alt as never)) return { mandatsnr: leer(alt.mandatsnr), neu: false };
  let z = 1;
  let key = `${basis}${z}`;
  while (alt && key === leer(alt.mandkey) && z < 9) key = `${basis}${++z}`;
  await tx`insert into tco.sepa (adrnr, mandatsnr, mandkey, lastschriftart, typ, status, angelegtam, gueltigbis, manuell_aktiv)
           values (${zahler}, ${`${key}1`}, ${key}, 'Basis', 'W', 'X', ${datum}, null, false)
           on conflict (adrnr) do update set mandatsnr = excluded.mandatsnr, mandkey = excluded.mandkey, lastschriftart = excluded.lastschriftart,
             typ = excluded.typ, status = excluded.status, angelegtam = excluded.angelegtam, gueltigbis = null, manuell_aktiv = false`;
  return { mandatsnr: `${key}1`, neu: true };
}

/** Zahler-Vorschlag: Bankdaten und Hinweis auf ein bestehendes Mandat */
export async function zahlerVorschlag(db: Db, adrnr: string) {
  const [z] = await db`select iban1, bic1, bank1 from tco.mitglieder where adrnr = ${adrnr}`;
  const [s] = await db`select mandatsnr, status, angelegtam, gueltigbis, manuell_aktiv from tco.sepa where adrnr = ${adrnr}`;
  return {
    iban: leer(z?.iban1), bic: leer(z?.bic1), bank: leer(z?.bank1),
    hinweis: s && mandatAktiv(s as never)
      ? `Für den Zahler besteht bereits ein aktives SEPA-Mandat (${leer(s.mandatsnr)} vom ${dat(s.angelegtam)}). Es wird weiterverwendet, ein neues Mandat wird nicht angelegt.`
      : '',
  };
}

export async function mitgliedNeu(tx: Db, n: Neu): Promise<{ adrnr: string; mitglnrn: string; mandat: string; mandatNeu: boolean }> {
  if (!n.vertraege.length) throw new BusinessError('Bitte mindestens einen Vertrag auswählen.');
  const vn = condense(n.vorname), nn = condense(n.nachname);
  if (!n.anrede || !vn || !nn) throw new BusinessError('Bitte Anrede, Vorname und Nachname angeben.');
  if (!n.eintritt) throw new BusinessError('Bitte ein gültiges Eintrittsdatum angeben.');
  const email = n.email.trim();
  if (!emailGueltig(email)) throw new BusinessError('Die E-Mail-Adresse ist ungültig.');
  const ls = n.zahlungsart === 'L';
  const iban = normalisieren(n.iban), bic = normalisieren(n.bic);
  let zahler = '';
  let zAlt: Record<string, any> | undefined;
  if (ls) {
    if (!ibanGueltig(iban)) throw new BusinessError('Die IBAN ist ungültig (Prüfziffer/Länge).');
    if (n.zahler_modus === 'BESTEHEND') {
      zahler = leer(n.zahler_adrnr);
      [zAlt] = zahler ? await tx`select * from tco.mitglieder where adrnr = ${zahler}` : [];
      if (!zAlt) throw new BusinessError('Bitte einen bestehenden Zahler auswählen.');
      const ibanAlt = normalisieren(zAlt.iban1);
      if (ibanAlt && ibanAlt !== iban) {
        throw new BusinessError(`Die IBAN weicht von der beim Zahler ${condense(`${leer(zAlt.vorname)} ${leer(zAlt.nachname)}`)} hinterlegten IBAN ab. `
          + 'Bitte die Bankverbindung zuerst beim Zahler ändern oder „Neuer Zahler“ wählen.');
      }
    } else if (n.zahler_modus === 'NEU' && (!condense(n.z_vorname) || !condense(n.z_nachname))) {
      throw new BusinessError('Bitte Vor- und Nachname des Zahlers angeben.');
    }
  }
  const [dup] = await tx`select adrnr, mitglnrn from tco.mitglieder where vorname = ${vn} and nachname = ${nn}
                          and geburtsdatum is not distinct from ${n.geburtsdatum || null}`;
  if (dup) throw new BusinessError(`${vn} ${nn} ist bereits angelegt (Adressnummer ${nr(dup.adrnr)}${leer(dup.mitglnrn) ? `, Mitglied Nr. ${leer(dup.mitglnrn)}` : ''}).`);

  // Nummern: höchste Adressnummer + 1 (ohne Kunden-Adressen 99…), höchste Mitgliedsnummer + 1
  const [mx] = await tx`select coalesce(max(adrnr::bigint), 0) as n from tco.mitglieder where adrnr ~ '^[0-9]{1,10}$' and adrnr not like '99%'`;
  const next = Number(mx.n) + 1;
  const [mn] = await tx`select coalesce(max(mitglnrn::int), 0) as n from tco.mitglieder where mitglnrn ~ '^[0-9]{1,9}$'`;
  const adrnr = adrNummer(next), mitglnrn = String(Number(mn.n) + 1);

  const m: Record<string, unknown> = {
    adrnr, mitglnrn, anrede: n.anrede, geschlecht: n.anrede === 'Herr' ? '1' : n.anrede === 'Frau' ? '2' : null, vorname: vn, nachname: nn,
    alphabet: nn.slice(0, 1).toUpperCase(), strasse: condense(n.strasse) || null, plz: condense(n.plz) || null, ort: condense(n.ort) || null,
    telefon: condense(n.telefon) || null, telefon6: condense(n.mobil) || null, email: email || null, geburtsdatum: n.geburtsdatum || null,
    eintritt: n.eintritt, zahlungsart: n.zahlungsart, zahlungsweise: n.zahlungsweise || null, aktiv: 'J',
    checkbox1: n.datenschutz ? 'J' : 'N', checkbox2: n.bildrechte ? 'J' : 'N', checkbox3: 'N',
    iban1: null, bic1: null, bank1: null, mandatsrefenz: null, einzuglastmandliegtvor: null, adrnrkih: null, abwkontoinh: null,
  };
  let zNeu: Record<string, unknown> | null = null;
  if (ls) {
    Object.assign(m, { iban1: iban, bic1: bic || null, bank1: condense(n.bank) || null, mandatsrefenz: `${next}${mitglnrn}`, einzuglastmandliegtvor: n.sepa ? 'J' : null });
    if (n.zahler_modus === 'BESTEHEND' && zAlt) {
      Object.assign(m, { adrnrkih: zahler, abwkontoinh: condense(`${leer(zAlt.anrede)} ${leer(zAlt.vorname)} ${leer(zAlt.nachname)}`) });
    } else if (n.zahler_modus === 'NEU') {
      const zn = condense(n.z_nachname);
      zNeu = {
        adrnr: adrNummer(next + 1), anrede: n.z_anrede || null, geschlecht: n.z_anrede === 'Herr' ? '1' : n.z_anrede === 'Frau' ? '2' : null,
        vorname: condense(n.z_vorname), nachname: zn, alphabet: zn.slice(0, 1).toUpperCase(),
        strasse: condense(n.z_strasse) || m.strasse, plz: condense(n.z_plz) || m.plz, ort: condense(n.z_ort) || m.ort, email: n.z_email.trim() || null,
        iban1: m.iban1, bic1: m.bic1, bank1: m.bank1, zahlungsart: 'L', zahlungsweise: m.zahlungsweise, einzuglastmandliegtvor: m.einzuglastmandliegtvor,
      };
      zahler = zNeu.adrnr as string;
      Object.assign(m, { adrnrkih: zahler, abwkontoinh: condense(`${n.z_anrede} ${zNeu.vorname} ${zn}`) });
    } else zahler = adrnr;
  }
  await tx`insert into tco.mitglieder ${tx(m)}`;
  if (zNeu) await tx`insert into tco.mitglieder ${tx(zNeu)}`;
  if (n.zahler_modus === 'BESTEHEND' && ls && zAlt && !leer(zAlt.iban1)) {
    await tx`update tco.mitglieder set iban1 = ${m.iban1 as string}, bic1 = ${m.bic1 as string | null}, bank1 = ${m.bank1 as string | null} where adrnr = ${zahler}`;
  }
  let mandat = '', mandatNeu = false;
  if (ls && n.sepa) {
    const basis = zahler === adrnr ? (m.mandatsrefenz as string) : leer(zAlt?.mandatsrefenz) || String(Number(zahler));
    ({ mandatsnr: mandat, neu: mandatNeu } = await sepaAnlegen(tx, zahler, basis, n.sepa_datum || heute()));
  }
  const { arten } = await vertragsarten(tx, n.eintritt);
  let i = 0;
  for (const v of n.vertraege) {
    const a = arten.find((x) => x.art === v.art);
    if (!a) throw new BusinessError(`Die Vertragsart ${v.art} ist nicht (mehr) aktiv.`);
    if (!(v.betrag >= 0)) throw new BusinessError(`Betrag bei ${a.name} ist ungültig.`);
    await tx`insert into tco.vertraege (adrnr, vertragnr, art, artname, mitglnr, sollstellung, vertragbegin, betrag)
             values (${adrnr}, ${String(++i)}, ${a.art}, ${a.name}, ${mitglnrn}, ${v.turnus || a.turnus}, ${v.beginn || vertragsbeginn(n.eintritt, a.art)}, ${v.betrag})`;
  }
  return { adrnr, mitglnrn, mandat, mandatNeu };
}
