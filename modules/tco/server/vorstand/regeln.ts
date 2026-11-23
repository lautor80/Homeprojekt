/**
 * Vorstandssitzungen – reine Regeln ohne Datenbank (Nummern, Abstimmung, Beschlussfähigkeit, Namen, Datum).
 * Wird von der Logik, dem Markdown-Import und den Tests genutzt.
 */

export type Status = 'GEPLANT' | 'LAEUFT' | 'ENTWURF' | 'FREIGEGEBEN';
export type Teilnahme = 'OFFEN' | 'ANWESEND' | 'ENTSCHULDIGT' | 'FEHLT';
export type Ergebnis = 'ANGENOMMEN' | 'ABGELEHNT';

export const STATUS_TEXT: Record<Status, string> = {
  GEPLANT: 'Geplant', LAEUFT: 'Sitzung läuft', ENTWURF: 'Protokoll im Entwurf', FREIGEGEBEN: 'Freigegeben',
};
export const TEILNAHME_TEXT: Record<Teilnahme, string> = { OFFEN: 'offen', ANWESEND: 'anwesend', ENTSCHULDIGT: 'entschuldigt', FEHLT: 'fehlt' };
export const ART_TEXT = { VORSTAND: 'Vorstandssitzung', ERWEITERT: 'Erweiterte Vorstandssitzung' } as const;

/** erlaubte Statuswechsel; zurück aus „Freigegeben“ nur mit dem Recht zur Freigabe (prüft die Route) */
export const UEBERGAENGE: Record<Status, Status[]> = {
  GEPLANT: ['LAEUFT', 'ENTWURF'],
  LAEUFT: ['GEPLANT', 'ENTWURF'],
  ENTWURF: ['LAEUFT', 'FREIGEGEBEN'],
  FREIGEGEBEN: ['ENTWURF'],
};

export const sitzungNr = (jahr: number, lfd: number) => `VS ${jahr}/${String(lfd).padStart(2, '0')}`;
export const beschlussNr = (jahr: number, lfd: number) => `B ${jahr}/${String(lfd).padStart(3, '0')}`;

/**
 * Beschlussfähig, wenn mehr als die Hälfte der Vorstandsmitglieder anwesend ist (Gäste zählen nicht).
 * Ohne Vorstandsmitglieder (z. B. alte, importierte Protokolle ohne Zuordnung) gibt es keine Aussage.
 */
export function beschlussfaehig(t: { art: 'VORSTAND' | 'GAST'; status: Teilnahme }[]): { anwesend: number; gesamt: number; ok: boolean | null } {
  const v = t.filter((x) => x.art === 'VORSTAND');
  const anwesend = v.filter((x) => x.status === 'ANWESEND').length;
  return { anwesend, gesamt: v.length, ok: v.length ? anwesend * 2 > v.length : null };
}

/** Ergebnis aus den Stimmen: mehr Ja- als Nein-Stimmen = angenommen */
export const ergebnisAus = (ja: number | null | undefined, nein: number | null | undefined): Ergebnis | null =>
  ja == null && nein == null ? null : (ja ?? 0) > (nein ?? 0) ? 'ANGENOMMEN' : 'ABGELEHNT';

export interface Abstimmung { ja: number | null; nein: number | null; enthaltung: number | null; ergebnis: Ergebnis | null }

/**
 * Abstimmung aus freiem Text: „6/0/1“, „6:0:1“, „5 Ja, 1 Nein, 0 Enthaltungen“, „einstimmig“, „angenommen“, „abgelehnt“.
 * null = nichts erkannt.
 */
export function abstimmungLesen(s: string): Abstimmung | null {
  const t = s.toLowerCase();
  const drei = /(?<![\d.])(\d{1,3})\s*[/:]\s*(\d{1,3})\s*[/:]\s*(\d{1,3})(?![\d.])/.exec(t);
  if (drei) {
    const [ja, nein, enthaltung] = [Number(drei[1]), Number(drei[2]), Number(drei[3])];
    return { ja, nein, enthaltung, ergebnis: ergebnisAus(ja, nein) };
  }
  const zahl = (re: RegExp) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const ja = zahl(/(\d{1,3})\s*(?:x\s*)?(?:ja\b|dafür|für\b)/);
  const nein = zahl(/(\d{1,3})\s*(?:x\s*)?(?:nein\b|dagegen|gegen\b)/);
  const enthaltung = zahl(/(\d{1,3})\s*(?:x\s*)?enthaltung/);
  const einstimmig = /\beinstimmig\b/.test(t);
  if (ja != null || nein != null || enthaltung != null) {
    const n = nein ?? (einstimmig ? 0 : null);
    return { ja, nein: n, enthaltung, ergebnis: einstimmig && ja == null ? 'ANGENOMMEN' : ergebnisAus(ja, n) };
  }
  if (einstimmig) return { ja: null, nein: 0, enthaltung: null, ergebnis: /abgelehnt/.test(t) ? 'ABGELEHNT' : 'ANGENOMMEN' };
  if (/\babgelehnt\b/.test(t)) return { ja: null, nein: null, enthaltung: null, ergebnis: 'ABGELEHNT' };
  if (/\bangenommen\b|\bbeschlossen\b/.test(t)) return { ja: null, nein: null, enthaltung: null, ergebnis: 'ANGENOMMEN' };
  return null;
}

export function abstimmungText(a: { ja: number | null; nein: number | null; enthaltung: number | null; ergebnis: Ergebnis | null }): string {
  const z = [a.ja != null && `Ja ${a.ja}`, a.nein != null && `Nein ${a.nein}`, a.enthaltung != null && `Enthaltung ${a.enthaltung}`].filter(Boolean).join(' · ');
  const e = a.ergebnis === 'ANGENOMMEN' ? 'angenommen' : a.ergebnis === 'ABGELEHNT' ? 'abgelehnt' : '';
  return [z, e].filter(Boolean).join(' – ');
}

const gueltig = (y: number, m: number, d: number) => {
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
};
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Datum aus Text: 2025-12-03, 03.12.2025, 3.12.25, „3. Dezember 2025“; ohne Jahr („bis 10.12.“) mit dem Bezugsdatum –
 * liegt der Tag davor, ist das Folgejahr gemeint. null = kein (gültiges) Datum.
 */
export function datumLesen(s: string, bezug?: string | null): string | null {
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return gueltig(+m[1], +m[2], +m[3]) ? iso(+m[1], +m[2], +m[3]) : null;
  m = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})?(?!\d)/.exec(s);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : NaN;
    if (m[3] && m[3].length === 2) y += 2000;
    if (!m[3]) {
      if (!bezug) return null;
      y = +bezug.slice(0, 4);
      if (gueltig(y, mo, d) && iso(y, mo, d) < bezug) y++;
    }
    return gueltig(y, mo, d) ? iso(y, mo, d) : null;
  }
  const MONATE = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
  m = /(?<!\d)(\d{1,2})\.?\s+(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+(\d{4})/i.exec(s);
  if (m) {
    const mo = MONATE.indexOf(m[2].toLowerCase().replace('maerz', 'märz')) + 1;
    return gueltig(+m[3], mo, +m[1]) ? iso(+m[3], mo, +m[1]) : null;
  }
  return null;
}

/** Uhrzeit(en) aus Text: „19:30“, „19.30 Uhr“, „19:30–21:45“ */
export function zeitenLesen(s: string): { beginn: string | null; ende: string | null } {
  const z = [...s.matchAll(/(?<![\d.])([01]?\d|2[0-3])[:.]([0-5]\d)(?![\d.]*\.\d{2,4})/g)].map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
  return { beginn: z[0] ?? null, ende: z[1] ?? null };
}

/** Vergleichsform eines Namens: klein, ohne Akzente, ß = ss, Bindestriche und Punkte als Leerzeichen */
const norm = (s: string) => s.toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.\-_]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface Person { adrnr: string; vorname: string; nachname: string }

/**
 * Namen aus einem Protokoll einer Person zuordnen: „Nachname, Vorname“, „Vorname Nachname“, „V. Nachname“ oder nur
 * der Nachname bzw. Vorname, wenn er unter den Personen eindeutig ist. null = keine eindeutige Zuordnung.
 */
export function personZuordnen(name: string, personen: Person[]): Person | null {
  const roh = name.replace(/\(.*?\)/g, ' ');
  const teile = roh.includes(',') ? roh.split(',').map(norm).reverse().join(' ') : norm(roh);
  const w = teile.split(' ').filter(Boolean);
  if (!w.length) return null;
  const voll = personen.filter((p) => {
    const vn = norm(p.vorname).split(' ')[0] ?? '', nn = norm(p.nachname);
    if (!nn) return false;
    const nnTeile = nn.split(' ');
    const hatNn = nnTeile.every((x) => w.includes(x));
    return hatNn && w.some((x) => x === vn || (x.length === 1 && vn.startsWith(x)));
  });
  if (voll.length === 1) return voll[0];
  if (voll.length > 1) return null;
  if (w.length !== 1) return null;
  const nur = personen.filter((p) => norm(p.nachname) === w[0]);
  if (nur.length === 1) return nur[0];
  const vor = personen.filter((p) => (norm(p.vorname).split(' ')[0] ?? '') === w[0]);
  return !nur.length && vor.length === 1 ? vor[0] : null;
}

/**
 * Namensliste aus einer Zeile: Trenner Semikolon, sonst Komma. Stehen nur einzelne Wörter mit Komma dazwischen
 * („Laub, Torsten, Müller, Hans“), sind es Paare „Nachname, Vorname“. Zusätze in Klammern bleiben am Namen.
 */
export function namenLesen(s: string): string[] {
  const t = s.replace(/\*\*|__/g, '').trim();
  if (!t || /^[-–—]$|^keine?$/i.test(t)) return [];
  const teile = (t.includes(';') ? t.split(';') : t.split(/,(?![^(]*\))/)).flatMap((x) => x.split(/\s+und\s+|\s+&\s+/)).map((x) => x.trim()).filter(Boolean);
  if (!t.includes(';') && teile.length >= 2 && teile.length % 2 === 0 && teile.every((x) => /^[\p{L}'’-]+$/u.test(x))) {
    const paare: string[] = [];
    for (let i = 0; i < teile.length; i += 2) paare.push(`${teile[i]}, ${teile[i + 1]}`);
    return paare;
  }
  return teile;
}

/** Anzeigeform einer Person: „Vorname Nachname“ */
export const personName = (p: Pick<Person, 'vorname' | 'nachname'>) => `${p.vorname} ${p.nachname}`.replace(/\s+/g, ' ').trim();

/**
 * Verantwortliche immer mit Vornamen: „weiß, kas, laub“ → „Jan Weißing, Christian Kasper, Torsten Laub“.
 * Erst der ganze Text als eine Person („Laub, Torsten“), sonst je Teil (Trenner , ; / & + „und“): voller Name, eindeutiger
 * Nach- oder Vorname, dann eindeutiger Anfang (ab 2 Buchstaben) von Nach- oder Vorname. Was nicht eindeutig ist, bleibt,
 * wie es eingegeben wurde.
 */
export function verantwortlicheAnzeigen(text: string | null | undefined, personen: Person[]): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // eine Person, auch als „Nachname, Vorname“ – nur wenn höchstens ein Komma und sonst kein Trenner vorkommt
  const ganz = /^[^,;/&+]+(?:,[^,;/&+]+)?$/.test(t) && !/\s+und\s+/i.test(t) ? personZuordnen(t, personen) : null;
  if (ganz) return personName(ganz);
  const teile = t.split(/\s*[,;/&+]\s*|\s+und\s+/i).map((x) => x.trim()).filter(Boolean);
  const namen = teile.map((x) => {
    const p = personZuordnen(x, personen);
    if (p) return personName(p);
    const w = norm(x);
    if (w.length < 2 || w.includes(' ')) return x;
    const treffer = personen.filter((q) => norm(q.nachname).startsWith(w) || (norm(q.vorname).split(' ')[0] ?? '').startsWith(w));
    const eindeutig = [...new Map(treffer.map((q) => [personName(q), q])).values()];
    return eindeutig.length === 1 ? personName(eindeutig[0]) : x;
  });
  return [...new Set(namen)].join(', ');
}
