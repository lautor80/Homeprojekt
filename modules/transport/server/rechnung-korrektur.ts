/**
 * Rechnung zur Korrektur öffnen und mit derselben Nummer neu erzeugen.
 *
 *  - Öffnen: Rechnungsnummer und -datum wandern nach faktura_reserviert / fakturadatum_reserviert, faktura wird leer –
 *    der Auftrag ist wieder bearbeitbar. Es zählt die ganze Rechnung (Sammelrechnung: alle ihre Aufträge).
 *  - Neu erzeugen: Aufträge mit vorgemerkter Nummer bekommen genau diese Nummer und ihr ursprüngliches Rechnungsdatum zurück;
 *    nur die übrigen offenen Aufträge bekommen neue Nummern.
 *  - Vermerk: steht mit dem Datum der Korrektur auf der Rechnung (PDF und E-Rechnung).
 *
 * Reine Funktionen ohne Datenbank – getestet in server/test/transport_rechnung_korrektur.test.ts.
 */

export interface PlanZeile {
  auftragsnr: string;
  faktura: string | null;
  abgeschlossen_am: unknown;
  faktura_reserviert: string | null;
  fakturadatum_reserviert: string | null;
}

export interface RechnungsPlan {
  /** Rechnungen, die mit ihrer bisherigen Nummer wieder erzeugt werden */
  korrekturen: { faktura: string; datum: string | null; auftraege: string[] }[];
  /** offene Aufträge ohne vorgemerkte Nummer – bekommen neue Nummern */
  neu: string[];
  /** ausgewählt, aber schon fakturiert oder ohne Rechnung abgeschlossen */
  ignoriert: number;
}

/**
 * Plant das Erzeugen von Rechnungen. zeilen enthält die ausgewählten Aufträge und – für vorgemerkte Rechnungen – auch die
 * nicht ausgewählten übrigen Aufträge derselben Rechnung, damit eine Sammelrechnung vollständig bleibt.
 */
export function rechnungenPlanen(zeilen: PlanZeile[], ausgewaehlt: string[]): RechnungsPlan {
  const sel = new Set(ausgewaehlt);
  const korrekturen = new Map<string, { faktura: string; datum: string | null; auftraege: string[] }>();
  const neu: string[] = [];
  let ignoriert = 0;
  for (const z of [...zeilen].sort((a, b) => a.auftragsnr.localeCompare(b.auftragsnr))) {
    if (z.faktura || z.abgeschlossen_am) {
      if (sel.has(z.auftragsnr)) ignoriert++;
      continue;
    }
    if (z.faktura_reserviert) {
      const k = korrekturen.get(z.faktura_reserviert) ?? { faktura: z.faktura_reserviert, datum: z.fakturadatum_reserviert, auftraege: [] };
      k.auftraege.push(z.auftragsnr);
      korrekturen.set(z.faktura_reserviert, k);
    } else if (sel.has(z.auftragsnr)) {
      neu.push(z.auftragsnr);
    }
  }
  return { korrekturen: [...korrekturen.values()].sort((a, b) => a.faktura.localeCompare(b.faktura)), neu, ignoriert };
}

const dat = (iso: string) => iso.split('-').reverse().join('.');

/** Text auf der Rechnung, z. B. „Korrigierte Rechnung vom 23.11.2026: Frachtpreis angepasst“ – ohne Korrektur leer */
export function korrekturVermerk(vermerk: string | null | undefined, korrigiertAm: string | null | undefined): string {
  const v = (vermerk ?? '').replace(/\s+/g, ' ').trim();
  if (!korrigiertAm && !v) return '';
  const kopf = korrigiertAm ? `Korrigierte Rechnung vom ${dat(korrigiertAm)}` : 'Korrigierte Rechnung';
  return v ? `${kopf}: ${v}` : `${kopf}.`;
}
