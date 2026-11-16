/**
 * Betrag in Buchstaben für die Zuwendungsbestätigung („- in Buchstaben -“): deutsche Zahlwörter mit Euro und Cent,
 * z. B. 1.234,56 → „eintausendzweihundertvierunddreißig Euro und sechsundfünfzig Cent“. Reine Funktion ohne Abhängigkeiten.
 */

const EINER = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf',
  'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const ZEHNER = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

/** 1–999; eine Eins am Ende lautet „ein“ (vor „tausend“, „Euro“ …) – das „s“ von „eins“ setzt der Aufrufer */
function unterTausend(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let s = h ? `${EINER[h]}hundert` : '';
  if (r < 20) s += EINER[r];
  else {
    const e = r % 10;
    s += (e ? `${EINER[e]}und` : '') + ZEHNER[Math.floor(r / 10)];
  }
  return s;
}

/** endet die Zahl auf die Ziffernfolge …01 (1, 101, 1001 …), heißt das Zahlwort allein stehend „…eins“ */
const endetAufEins = (n: number) => n % 100 === 1;

/**
 * Ganze Zahl von 0 bis 999.999.999.999 als Zahlwort („null“, „eins“, „einundzwanzig“, „eintausendeins“,
 * „eine Million zweihunderttausend“). Millionen und Milliarden stehen als eigene Wörter.
 */
export function zahlwort(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999_999) throw new RangeError(`Zahlwort nur für ganze Zahlen von 0 bis 999.999.999.999 (${n})`);
  if (n === 0) return 'null';
  const teile: string[] = [];
  const mrd = Math.floor(n / 1_000_000_000);
  const mio = Math.floor(n / 1_000_000) % 1000;
  const tsd = Math.floor(n / 1000) % 1000;
  const rest = n % 1000;
  if (mrd) teile.push(mrd === 1 ? 'eine Milliarde' : `${unterTausend(mrd)} Milliarden`);
  if (mio) teile.push(mio === 1 ? 'eine Million' : `${unterTausend(mio)} Millionen`);
  let klein = tsd ? `${unterTausend(tsd)}tausend` : '';
  if (rest) klein += unterTausend(rest) + (endetAufEins(rest) ? 's' : '');
  if (klein) teile.push(klein);
  return teile.join(' ');
}

/** Zahlwort vor einem Hauptwort: genau 1 heißt „ein“ (ein Euro, ein Cent), sonst wie zahlwort() */
const vorHauptwort = (n: number) => (n === 1 ? 'ein' : zahlwort(n));

/**
 * Betrag in Buchstaben mit Währung: „einhundert Euro“, „zwölf Euro und fünfzig Cent“, „null Euro und ein Cent“.
 * Gerundet wird kaufmännisch auf Cent; negative Beträge und Beträge ab einer Billion sind nicht zulässig.
 */
export function betragInWorten(betrag: number): string {
  if (!Number.isFinite(betrag) || betrag < 0) throw new RangeError(`Betrag in Buchstaben nur für Beträge ab 0 (${betrag})`);
  const cent = Math.round((betrag + Number.EPSILON) * 100);
  const euro = Math.floor(cent / 100);
  const c = cent % 100;
  return `${vorHauptwort(euro)} Euro${c ? ` und ${vorHauptwort(c)} Cent` : ''}`;
}
