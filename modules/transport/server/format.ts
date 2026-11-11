/** Formatierung wie in den ABAP-Klassen (unabhängig von Benutzereinstellungen). */

/** 1.234,56 € */
export function eur(v: number, mitZeichen = true): string {
  const s = Math.abs(v).toFixed(2);
  const [int, dec] = s.split('.');
  const grp = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${v < 0 ? '-' : ''}${grp},${dec}${mitZeichen ? ' €' : ''}`;
}

/** 1.234,56 (ohne Währung) */
export const betrag = (v: number) => eur(v, false);

/** TT.MM.JJJJ aus JJJJ-MM-TT */
export function dat(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

export const heute = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function addTage(iso: string, tage: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  return d.toISOString().slice(0, 10);
}

/** Text zusammenfassen wie ABAP condense (Mehrfach-Leerzeichen, Ränder) */
export const condense = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** EU-Mitgliedsstaaten (ohne DE) für Reverse Charge */
export const EU = 'AT BE BG CY CZ DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' ');

/**
 * Steuerkategorie (UNTDID 5305) je Auftrag – gleiche Logik wie ZCL_EU_XRECHNUNG:
 *   S  = USt-Satz (Auftrag steuerrelevant)
 *   E  = steuerfrei (Empfänger im Inland, nicht steuerrelevant)
 *   AE = Reverse Charge (Empfänger in einem anderen EU-Staat)
 *   O  = nicht im Inland steuerbar (Empfänger außerhalb der EU)
 */
export function kategorie(steuerrelevant: boolean, land: string | null | undefined, befreiung?: string | null): 'S' | 'E' | 'AE' | 'O' {
  if (steuerrelevant) return 'S';
  // gewählter Grund (#121) hat Vorrang vor der Ableitung aus dem Land
  if (befreiung === 'RC') return 'AE';
  if (befreiung === 'DRITTLAND') return 'E';
  if (!land || land === 'DE') return 'E';
  if (EU.includes(land.toUpperCase())) return 'AE';
  return 'O';
}

/** Grund ohne MwSt (#121) – Text auf Rechnung und in der E-Rechnung */
export type Befreiung = 'RC' | 'DRITTLAND';
export const BEFREIUNG_TEXT: Record<Befreiung, string> = {
  RC: 'Übergang der Steuerschuld auf den Leistungsempfänger (Reverse Charge)',
  DRITTLAND: 'Umsatzsteuerfreier Transport in ein Drittland gem. § 4 Nr. 3 Buchst. a Unterbuchstabe aa UStG',
};
/** Befreiungsgrund je Steuerkategorie; E aus Drittland-Transport mit dem Paragraphen, sonst inländisch steuerfrei */
export const steuerGrund = (kat: string, drittland = false) =>
  kat === 'AE' ? BEFREIUNG_TEXT.RC : kat === 'O' ? 'Nicht im Inland steuerbare Leistung' : kat === 'E' ? (drittland ? BEFREIUNG_TEXT.DRITTLAND : 'Steuerfreie Leistung') : '';

export const katText = (kat: string, satz: number) =>
  ({ S: `${String(satz).replace('.', ',')} %`, AE: '0 % (Reverse Charge)', O: 'nicht steuerbar', E: '0 % (steuerfrei)' })[kat] ?? kat;

/** Nettobetrag aus dem gespeicherten Bruttobetrag zurückrechnen */
export const netto = (brutto: number, kat: string, satz: number) =>
  Math.round(((kat === 'S' ? (brutto * 100) / (100 + satz) : brutto) + Number.EPSILON) * 100) / 100;
