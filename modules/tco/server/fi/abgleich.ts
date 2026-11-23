import { runden } from '../format.js';

/**
 * Abgleich der Bankumsätze mit vorhandenen Buchungen (BANK_MATCH_EXISTING) – ohne Datenbank, damit testbar.
 *
 * Jede vorhandene Buchung wird höchstens einmal verbraucht. Reihenfolge:
 * 1. Zahler: gleicher Betrag, höchstens 7 Tage auseinander und der Name des Zahlers steht im Buchungstext.
 *    Erst danach greifen die Läufe nur nach Betrag – sonst „verbraucht“ ein anderer Zahler mit gleichem Betrag
 *    die Buchung (Klimov 24 € hielt die Mueller-Buchung für seine, Mueller wurde doppelt gebucht).
 * 2. Gleicher Betrag am selben Tag (Buchungs- oder Valutadatum), 3. gleicher Betrag ±7 Tage.
 *    Buchungen, deren Text einen anderen Zahler der Datei nennt, kommen dabei nicht in Frage.
 * 4. Sammelposition: mehrere Buchungen mit gleicher Belegnummer und gleichem Datum ergeben den Betrag.
 */

export interface AbgleichUmsatz {
  datum: string;
  valuta: string | null;
  name: string;
  betrag: number;
  status: 'neu' | 'gebucht';
  statusText: string;
}

export interface VorhandeneBuchung {
  internenr: string;
  datum: string;
  betrag: number;
  belnr: string;
  text: string;
}

/** Namensteile (mind. 3 Zeichen, ohne Umlaut-/Großschreibungsunterschiede) */
export const namensTeile = (s: string) => s.toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
  .split(/[^A-Z0-9]+/).filter((t) => t.length >= 3);

/** Nennt der Buchungstext den Zahler? (alle Namensteile kommen im Text vor) */
export function nenntZahler(name: string, text: string): boolean {
  const n = namensTeile(name);
  if (!n.length) return false;
  const t = new Set(namensTeile(text));
  return n.every((x) => t.has(x));
}

const tage = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function abgleichen<U extends AbgleichUmsatz>(umsaetze: U[], vorhanden: VorhandeneBuchung[]): void {
  const v = vorhanden.map((x) => ({ ...x, betrag: runden(x.betrag), frei: true }));
  const offen = () => umsaetze.filter((x) => x.status === 'neu');
  const treffer = (x: U, t: (typeof v)[number], text = `bereits gebucht (intern ${t.internenr})`) => {
    t.frei = false;
    x.status = 'gebucht';
    x.statusText = text;
  };
  const naechste = (x: U, k: typeof v) => [...k].sort((a, b) => tage(a.datum, x.datum) - tage(b.datum, x.datum))[0];

  // 1. nach Zahler
  for (const x of offen()) {
    const t = naechste(x, v.filter((y) => y.frei && y.betrag === x.betrag && tage(y.datum, x.datum) <= 7 && nenntZahler(x.name, y.text)));
    if (t) treffer(x, t);
  }
  // Buchung gehört erkennbar zu einem anderen Zahler der Datei (auch wenn dessen Umsatz schon zugeordnet ist)
  const fremd = (x: U, y: (typeof v)[number]) => umsaetze.some((z) => z !== x && namensTeile(z.name).length > 0
    && !nenntZahler(x.name, y.text) && nenntZahler(z.name, y.text));
  // 2. gleicher Betrag, gleicher Tag
  for (const x of offen()) {
    const t = v.find((y) => y.frei && y.betrag === x.betrag && (y.datum === x.datum || y.datum === x.valuta) && !fremd(x, y));
    if (t) treffer(x, t);
  }
  // 3. gleicher Betrag ±7 Tage
  for (const x of offen()) {
    const t = naechste(x, v.filter((y) => y.frei && y.betrag === x.betrag && tage(y.datum, x.datum) <= 7 && !fremd(x, y)));
    if (t) treffer(x, t);
  }
  // 4. Sammelposition
  for (const x of offen()) {
    const gruppen = new Map<string, typeof v>();
    for (const y of v.filter((z) => z.frei && z.belnr && tage(z.datum, x.datum) <= 12)) {
      const k = `${y.datum}|${y.belnr}`;
      gruppen.set(k, [...(gruppen.get(k) ?? []), y]);
    }
    for (const g of gruppen.values()) {
      if (g.length < 2 || runden(g.reduce((s, y) => s + y.betrag, 0)) !== x.betrag) continue;
      g.forEach((y) => { y.frei = false; });
      x.status = 'gebucht';
      x.statusText = `bereits gebucht (Sammelposition ${g.length} Belege, ${g[0].belnr})`;
      break;
    }
  }
}
