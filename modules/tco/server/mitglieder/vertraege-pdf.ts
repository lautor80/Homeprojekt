/**
 * Ausdruck „Verträge der Familie“ (Mitglieder → Verträge → Drucken): alle Verträge der Familie wie in der Baumansicht –
 * das Mitglied, ein abweichender Zahler und alle Personen, die über ihn bzw. das Mitglied zahlen – je Vertrag mit dem
 * Zahler. Am Ende je Zahler die Summe der laufenden Beiträge nach Turnus (Beträge verschiedener Turnusse werden nicht
 * zusammengezählt). Layout wie die übrigen Mitgliederunterlagen (Kopfband, Tabelle, Fußzeilen).
 */
import { maskIban } from '../../../../server/src/schutz.js';
import type { Db, Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { betragText } from '../pdf/layout.js';
import { Brief } from './pdf.js';
import { familieLesen, leer, mitgliedLesen, verweis, vertraegeLesen, type Vertrag } from './logik.js';

export interface FamilienVertrag extends Vertrag { zahlerName: string; zahlerAdrnr: string }

const TURNUS_KURZ: Record<string, string> = { monatlich: '/Monat', vierteljährlich: '/Quartal', halbjährlich: '/Halbjahr', jährlich: '/Jahr' };
const ende = (d: string | null) => (!d || d === '9999-12-31' ? 'unbefristet' : dat(d));

/** Verträge der Familie mit dem Zahler je Vertrag: abweichender Zahler am Vertrag, sonst der Zahler der Person, sonst die Person */
export async function familienVertraege(db: Db, adrnr: string, o: { beendete?: boolean } = {}) {
  const m = await mitgliedLesen(db, adrnr);
  const familie = await familieLesen(db, m);
  const name = new Map(familie.map((p) => [p.adrnr, p.name]));
  const reihenfolge = new Map(familie.map((p, i) => [p.adrnr, i]));
  const zahltUeber = new Map(familie.map((p) => [p.adrnr, p.zahlt_ueber]));
  const alle = await vertraegeLesen(db, m, familie.map((p) => p.adrnr));
  const vt: FamilienVertrag[] = alle.filter((v) => o.beendete || v.laeuft).map((v) => {
    const z = verweis(v.zahler_adrnr) || verweis(zahltUeber.get(v.adrnr)) || v.adrnr;
    const zahlerName = name.get(z) ?? (v.zahler_adrnr ? v.zahler.replace(/^(.*), (.*)$/, '$2 $1') : `${Number(z) || z}`);
    return { ...v, zahlerAdrnr: z, zahlerName };
  }).sort((a, b) => (reihenfolge.get(a.adrnr) ?? 99) - (reihenfolge.get(b.adrnr) ?? 99) || (Number(a.vertragnr) || 0) - (Number(b.vertragnr) || 0));
  // Zahler: Zahlungsart und IBAN (gekürzt) für die Zusammenfassung
  const ids = [...new Set(vt.map((v) => v.zahlerAdrnr))];
  const zahlerDaten = ids.length ? await db`select adrnr, zahlungsart, iban1 from tco.mitglieder where adrnr = any(${ids})` : [];
  const zahler = ids.map((id) => {
    const d = zahlerDaten.find((x) => x.adrnr === id);
    const laufend = vt.filter((v) => v.zahlerAdrnr === id && v.laeuft);
    const jeTurnus = new Map<string, number>();
    for (const v of laufend) jeTurnus.set(v.sollstellung || '–', (jeTurnus.get(v.sollstellung || '–') ?? 0) + v.betrag);
    return {
      adrnr: id, name: vt.find((v) => v.zahlerAdrnr === id)!.zahlerName, anzahl: laufend.length,
      summe: [...jeTurnus].map(([t, b]) => `${betragText(b)}${TURNUS_KURZ[t] ?? ` ${t}`}`).join(' · ') || '–',
      zahlweg: leer(d?.zahlungsart) === 'L' ? (leer(d?.iban1) ? `Lastschrift ${maskIban(leer(d?.iban1))}` : 'Lastschrift (ohne IBAN)') : leer(d?.zahlungsart) ? 'Überweisung' : '–',
    };
  });
  return { mitglied: condense(`${leer(m.vorname)} ${leer(m.nachname)}`), nachname: leer(m.nachname), vorname: leer(m.vorname), vertraege: vt, zahler };
}

export async function familienVertraegePdf(db: Db, v: Verein, adrnr: string, o: { beendete?: boolean } = {}): Promise<{ pdf: Buffer; dateiname: string }> {
  const d = await familienVertraege(db, adrnr, o);
  const b = new Brief(v, `Verträge der Familie – ${d.mitglied}`);
  b.kopfband('Verträge der Familie', `${d.mitglied} · Stand ${dat(heute())}${o.beendete ? ' · mit beendeten Verträgen' : ''}`);
  b.y = 58;
  b.ueberschrift('Verträge');
  let vorher = '';
  b.tabelle(
    [{ x: 23, t: 'PERSON' }, { x: 52, t: 'VERTRAG' }, { x: 98, t: 'BEGINN' }, { x: 117, t: 'ENDE' }, { x: 137, t: 'ZAHLER' }, { x: 187, t: 'BETRAG', r: true }],
    d.vertraege.map((x, i) => {
      const neu = x.adrnr !== vorher;
      vorher = x.adrnr;
      return {
        trenner: neu && i > 0,
        werte: [
          ...(neu ? [{ x: 23, t: x.person, w: 27 }] : []),
          { x: 52, t: `${x.art} – ${x.artname}${x.laeuft ? '' : ' (beendet)'}`, w: 44 },
          { x: 98, t: x.vertragbegin ? dat(x.vertragbegin) : '–' }, { x: 117, t: ende(x.vertragende) },
          { x: 137, t: x.zahlerAdrnr === x.adrnr ? 'selbst' : x.zahlerName, w: 27 },
          { x: 187, t: `${betragText(x.betrag)}${TURNUS_KURZ[x.sollstellung] ?? ''}`, r: true },
        ],
      };
    }), o.beendete ? 'Es sind keine Verträge hinterlegt.' : 'Es sind keine laufenden Verträge hinterlegt.');

  if (d.zahler.length) {
    b.y += 8;
    b.platz(22 + 7 * d.zahler.length);
    b.ueberschrift('Je Zahler (laufende Verträge)');
    b.tabelle(
      [{ x: 23, t: 'ZAHLER' }, { x: 70, t: 'VERTRÄGE' }, { x: 90, t: 'ZAHLWEG' }, { x: 187, t: 'SUMME', r: true }],
      d.zahler.map((z) => ({ werte: [{ x: 23, t: z.name, w: 45 }, { x: 70, t: String(z.anzahl) }, { x: 90, t: z.zahlweg, w: 52 }, { x: 187, t: z.summe, r: true }] })), '');
  }
  const datei = `Vertraege_Familie_${d.nachname}_${d.vorname}`.replace(/[^\wäöüÄÖÜß-]+/g, '_');
  return { pdf: await b.fertig(), dateiname: `${datei}.pdf` };
}
