/**
 * E-Mail-Datei (.eml, RFC 5322/MIME) im Browser zerlegen – für „E-Mail aus Outlook in den Auftrag ziehen“:
 * Die Anhänge werden herausgelöst und wie hineingezogene Dateien abgelegt (Auftragsordner, Paperless).
 *
 * Ohne Abhängigkeiten und ohne Server: Die Datei wird byteweise als „binary string“ (1 Zeichen = 1 Byte) gelesen,
 * damit Base64-/Quoted-Printable-Teile und 8-Bit-Inhalte unverfälscht bleiben.
 *  - verschachtelte multipart/* mit Grenzen (boundary), Kopfzeilen mit Fortsetzungszeilen
 *  - Content-Transfer-Encoding base64, quoted-printable, 7bit/8bit/binary
 *  - Dateinamen aus Content-Disposition „filename“ bzw. Content-Type „name“, auch RFC 2231 (filename*=, filename*0*=…)
 *    und RFC 2047 (=?utf-8?B?…?=, =?iso-8859-1?Q?…?=)
 *  - weitergeleitete E-Mails als Anhang (message/rfc822) bleiben eine .eml-Datei
 *  - eingebettete Bilder der Nachricht (Signatur-Logos: inline mit Content-ID) zählen nicht als Anhang
 */

export interface EmlAnhang { name: string; typ: string; daten: Uint8Array }
export interface Eml {
  betreff: string;
  von: string;
  /** Datum laut Kopf, wie geschrieben (z. B. „Mon, 16 Nov 2026 10:12:00 +0100“) */
  datum: string;
  anhaenge: EmlAnhang[];
  /** übersprungene eingebettete Bilder (Signatur, Logos) */
  eingebettet: number;
}

interface Teil { kopf: Map<string, string>; rumpf: string }

/** Ist die Datei eine E-Mail-Datei? */
export const istEml = (f: { name: string; type: string }) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822';

/** Uint8Array → binary string (1 Zeichen je Byte), stückweise wegen der Argumentgrenze von fromCharCode */
export function bytesZuBinaer(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
const binaerZuBytes = (s: string) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

function textAus(bytes: Uint8Array, charset = 'utf-8'): string {
  const cs = charset.trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try { return new TextDecoder(cs === 'ascii' || cs === 'us-ascii' ? 'utf-8' : cs).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Kopf und Rumpf trennen (erste Leerzeile), Fortsetzungszeilen zusammenfügen; Namen klein */
function teilLesen(roh: string): Teil {
  const m = /\r?\n\r?\n/.exec(roh);
  const kopfText = m ? roh.slice(0, m.index) : roh;
  const rumpf = m ? roh.slice(m.index + m[0].length) : '';
  const kopf = new Map<string, string>();
  let letzter = '';
  for (const zeile of kopfText.split(/\r?\n/)) {
    if (/^[ \t]/.test(zeile) && letzter) { kopf.set(letzter, `${kopf.get(letzter)} ${zeile.trim()}`); continue; }
    const i = zeile.indexOf(':');
    if (i <= 0) continue;
    letzter = zeile.slice(0, i).trim().toLowerCase();
    if (!kopf.has(letzter)) kopf.set(letzter, zeile.slice(i + 1).trim());
  }
  return { kopf, rumpf };
}

/** RFC 2047: =?charset?B|Q?text?= in Kopfzeilen; Leerraum zwischen zwei kodierten Wörtern entfällt */
export function kopfDekodieren(wert: string): string {
  const roh = wert.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return roh.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs: string, art: string, t: string) => {
    try {
      const bin = art.toUpperCase() === 'B' ? atob(t) : t.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
      return textAus(binaerZuBytes(bin), cs.split('*')[0]);
    } catch { return t; }
  });
}

/** Parameter einer Kopfzeile (z. B. boundary, charset, filename) – mit RFC 2231 (Fortsetzungen, charset''%XX) */
export function parameter(kopfwert: string, name: string): string | null {
  const teile: { nr: number; wert: string; kodiert: boolean }[] = [];
  let einfach: string | null = null;
  const re = /;\s*([^=;\s]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)/g;
  for (let m = re.exec(kopfwert); m; m = re.exec(kopfwert)) {
    const schluessel = m[1].toLowerCase();
    const wert = (m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2]).trim();
    if (schluessel === name) einfach = wert;
    const f = new RegExp(`^${name}\\*(?:(\\d+)\\*?)?$`).exec(schluessel);
    if (f) teile.push({ nr: f[1] ? Number(f[1]) : 0, wert, kodiert: schluessel.endsWith('*') });
  }
  if (teile.length) {
    teile.sort((a, b) => a.nr - b.nr);
    let charset = 'utf-8';
    const bin = teile.map((t, i) => {
      let w = t.wert;
      if (t.kodiert) {
        if (i === 0) { const q = /^([^']*)'[^']*'(.*)$/.exec(w); if (q) { charset = q[1] || charset; w = q[2]; } }
        return w.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
      return w;
    }).join('');
    return textAus(binaerZuBytes(bin), charset);
  }
  return einfach == null ? null : kopfDekodieren(einfach);
}

function rumpfDekodieren(t: Teil): Uint8Array {
  const cte = (t.kopf.get('content-transfer-encoding') ?? '').toLowerCase().trim();
  if (cte === 'base64') {
    // je Zeile dekodieren: manche Programme hängen mehrere Base64-Blöcke (mit eigener Auffüllung „=“) aneinander
    const zeilen = t.rumpf.split(/\r?\n/).map((z) => z.replace(/[^A-Za-z0-9+/=]/g, '')).filter(Boolean);
    const ganz = zeilen.join('');
    try { return binaerZuBytes(atob(ganz)); } catch { /* weiter je Block */ }
    try { return binaerZuBytes(zeilen.map((z) => atob(z)).join('')); } catch { return new Uint8Array(); }
  }
  if (cte === 'quoted-printable') {
    return binaerZuBytes(t.rumpf.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))));
  }
  return binaerZuBytes(t.rumpf);
}

/** Dateiendung zum Typ, wenn ein Anhang keinen Namen hat */
const ENDUNG: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/tiff': 'tif', 'image/webp': 'webp',
  'message/rfc822': 'eml', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
};

/** in Windows-Dateinamen unzulässige Zeichen ersetzen */
const dateiname = (n: string) => n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 180);

function sammeln(t: Teil, out: EmlAnhang[], zaehler: { eingebettet: number; nr: number }, tiefe: number) {
  const ct = t.kopf.get('content-type') ?? 'text/plain';
  const typ = ct.split(';')[0].trim().toLowerCase();
  const cd = t.kopf.get('content-disposition') ?? '';
  const disposition = cd.split(';')[0].trim().toLowerCase();
  const name = parameter(cd, 'filename') ?? parameter(ct, 'name');

  if (typ.startsWith('multipart/') && tiefe < 20) {
    const grenze = parameter(ct, 'boundary');
    if (!grenze) return;
    const marke = `--${grenze}`;
    const stuecke = t.rumpf.split(new RegExp(`(?:^|\\r?\\n)${marke.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*(?=\\r?\\n|$)`));
    // split mit Gruppe: [Vorspann, ende?, Teil, ende?, Teil, …]; nach dem Schluss-„--“ folgt der Nachspann
    for (let i = 2; i < stuecke.length; i += 2) {
      if (stuecke[i - 1] === '--') break;
      sammeln(teilLesen(stuecke[i].replace(/^\r?\n/, '')), out, zaehler, tiefe + 1);
    }
    return;
  }
  // Text der Nachricht selbst (ohne Namen, nicht als Anhang markiert) – kein Anhang
  if (!name && disposition !== 'attachment' && (typ === 'text/plain' || typ === 'text/html' || typ === 'text/calendar')) return;
  // eingebettete Bilder der Nachricht (Signatur, Logos): inline bzw. mit Content-ID ohne „attachment“
  if (typ.startsWith('image/') && disposition !== 'attachment' && (disposition === 'inline' || t.kopf.has('content-id'))) { zaehler.eingebettet++; return; }
  // Outlook-RTF-Hülle ohne Inhalt für andere Programme
  if (typ === 'application/ms-tnef' || /^winmail\.dat$/i.test(name ?? '')) return;
  zaehler.nr++;
  const endung = ENDUNG[typ] ?? 'bin';
  out.push({ name: dateiname(name || `Anhang ${zaehler.nr}.${endung}`) || `Anhang ${zaehler.nr}.${endung}`, typ, daten: rumpfDekodieren(t) });
}

/** E-Mail zerlegen (Bytes der .eml-Datei) */
export function emlLesen(bytes: Uint8Array): Eml {
  const wurzel = teilLesen(bytesZuBinaer(bytes));
  const anhaenge: EmlAnhang[] = [];
  const zaehler = { eingebettet: 0, nr: 0 };
  // Die E-Mail selbst ist kein Anhang – nur ihre Teile (eine reine Text-Mail hat keine Anhänge)
  const ct = (wurzel.kopf.get('content-type') ?? 'text/plain').split(';')[0].trim().toLowerCase();
  if (!ct.startsWith('text/') || wurzel.kopf.has('content-disposition')) sammeln(wurzel, anhaenge, zaehler, 0);
  // gleiche Dateinamen innerhalb der Mail unterscheiden: „bild.png“, „bild (2).png“
  const gesehen = new Map<string, number>();
  for (const a of anhaenge) {
    const k = a.name.toLowerCase();
    const n = (gesehen.get(k) ?? 0) + 1;
    gesehen.set(k, n);
    if (n > 1) { const p = a.name.lastIndexOf('.'); a.name = p > 0 ? `${a.name.slice(0, p)} (${n})${a.name.slice(p)}` : `${a.name} (${n})`; }
  }
  return {
    betreff: kopfDekodieren(wurzel.kopf.get('subject') ?? '').trim(),
    von: kopfDekodieren(wurzel.kopf.get('from') ?? '').trim(),
    datum: (wurzel.kopf.get('date') ?? '').trim(),
    anhaenge,
    eingebettet: zaehler.eingebettet,
  };
}
