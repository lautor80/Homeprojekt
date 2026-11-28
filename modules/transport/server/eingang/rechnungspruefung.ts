/**
 * Euroflex Posteingang – Eingangsrechnungen prüfen und zerlegen (reine Logik, ohne Datenbank und ohne PDF-Werkzeuge).
 *
 * 1. Seiten einordnen: Jede Seite eines PDFs ist Rechnung (R), Ablieferbeleg (A) oder eigener Transportauftrag (T).
 *    Der eigene Transportauftrag wird an den festen Texten erkannt, die das Portal selbst druckt (pdf/dokumente.ts).
 *    Ablieferbelege sind oft Scans mit Stempel und Handschrift – als Ablieferbeleg gilt deshalb, was weder Rechnung noch
 *    Transportauftrag ist. „sicher“ sagt, ob die Seite eindeutig war; nur eine rundum sichere Einordnung wird ohne Rückfrage
 *    aufgeteilt, alles andere bleibt ein Vorschlag.
 * 2. Aufteilen: Rechnungsseiten → „… – Rechnung.pdf“, Ablieferbelege → „… – Ablieferbelege.pdf“, der eigene Transportauftrag
 *    entfällt. Das Original bleibt unverändert im Portal.
 * 3. Firmierung prüfen: Der Text der Rechnungsseiten wird gegen die Firmendaten (Stammdaten → Firma) und die früheren
 *    Firmierungen (Einstellungen → Mail-Workflows → Eingang) gehalten.
 * Fachliche Beschreibung: docs/euroflex-mailworkflows.md, Abschnitt „Eingangsrechnungen“.
 */

export type Seitenart = 'R' | 'A' | 'T';
/** merkmal: Ablieferbeleg an einem Schlagwort erkannt (Lieferschein, CMR …) – nicht nur im Ausschluss */
export interface Seite { art: Seitenart; sicher: boolean; grund: string; merkmal?: boolean }
export const SEITENART_TEXT: Record<Seitenart, string> = { R: 'Rechnung', A: 'Ablieferbeleg', T: 'Transportauftrag' };

/** Text vergleichbar machen: klein, Umlaute und ß aufgelöst, alles außer Buchstaben und Ziffern wird ein Leerzeichen */
export function normal(text: string | null | undefined): string {
  return (text ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** USt-IdNr. vergleichbar: nur Buchstaben und Ziffern, groß („DE 814 480 003“ → „DE814480003“) */
export const ustidNormal = (x: string | null | undefined) => (x ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------- Seiten einordnen

/** feste Texte des eigenen Transportauftrags (pdf/dokumente.ts, pdf/transportauftrag-angaben.ts) */
const T_KOPF = /\btransportauftrag\b/;
const T_STARK = [/\btransport order\b/, /hiermit beauftragen wir sie mit dem folgenden transport/, /bitte immer auf der rechnung angeben/];
const T_FREMD = /\b(transportauftrag|speditionsauftrag|frachtauftrag|ladeauftrag|transport order)\b/;
const T_FOLGE = /\btransportauftrag 20\d{2} \d{4}( \d+)? fortsetzung\b/;

/** Merkmale einer Rechnung (auch Gutschrift im Gutschriftverfahren) – je Gruppe höchstens ein Punkt */
const R_MERKMALE: RegExp[] = [
  /\b(rechnung|invoice|faktura|facture|gutschrift)\b/,
  /\b(rechnungs ?(nr|nummer|no)|rechnung nr|invoice (no|number|nr)|beleg ?(nr|nummer)|gutschrift(s)? ?(nr|nummer))\b/,
  /\b(rechnungsdatum|invoice date|leistungsdatum|leistungszeitraum|lieferdatum)\b/,
  /\b(mwst|ust|umsatzsteuer|mehrwertsteuer|vat|steuerschuldnerschaft|reverse charge)\b/,
  /\b(nettobetrag|netto|bruttobetrag|brutto|gesamtbetrag|rechnungsbetrag|endbetrag|zahlbetrag|total amount|summe)\b/,
  /\b(zahlbar|zahlungsziel|zahlungsbedingungen?|faellig|ohne abzug|skonto|payment terms)\b/,
  /\b(iban|bic|swift|bankverbindung)\b/,
];
/** Merkmale eines Ablieferbelegs */
const A_MERKMALE = /\b(lieferschein|delivery note|ablieferbeleg|ablieferquittung|ablieferschein|abliefernachweis|empfangsbestaetigung|empfangsquittung|uebernahmebestaetigung|proof of delivery|pod|cmr|frachtbrief|lettre de voiture|ladeschein|wiegeschein|wiegenote|palettenschein|lademittelschein|packliste|warenbegleitschein|ware (vollstaendig|unbeschaedigt|erhalten)|unterschrift (des )?empfaenger|stempel)\b/;
const SEITE_N = /\b(seite|page|blatt) ?([2-9]|[1-9]\d)( ?(von|of|\/) ?\d+)?\b/;

/** Punkte einer Seite als Rechnung (0–7) */
export const rechnungsPunkte = (n: string) => R_MERKMALE.reduce((s, r) => s + (r.test(n) ? 1 : 0), 0);

/** eigener Transportauftrag: Kopf „Transportauftrag“ und mindestens zwei der festen Texte – oder die Kopfzeile der Folgeseite */
export function istEigenerTransportauftrag(n: string): boolean {
  if (T_FOLGE.test(n)) return true;
  return T_KOPF.test(n) && T_STARK.filter((r) => r.test(n)).length >= 2;
}

/**
 * Seiten eines Dokuments einordnen. texte: erkannter Text je Seite (leer = nichts lesbar, z. B. Scan ohne Texterkennung).
 * Eine Folgeseite der Rechnung (nach einer Rechnungsseite, mit Summen/Zahlungsangaben oder „Seite 2“) bleibt Rechnung.
 */
export function seitenEinordnen(texte: string[]): Seite[] {
  const erg: Seite[] = [];
  for (const roh of texte) {
    const n = normal(roh);
    const vor = erg[erg.length - 1];
    const nachR = vor?.art === 'R';
    if (istEigenerTransportauftrag(n)) { erg.push({ art: 'T', sicher: true, grund: 'eigener Transportauftrag (feste Texte des Portals)' }); continue; }
    const r = rechnungsPunkte(n);
    const a = A_MERKMALE.test(n);
    const wort = R_MERKMALE[0].test(n);
    const nummer = R_MERKMALE[1].test(n);
    const summe = R_MERKMALE[4].test(n) || R_MERKMALE[5].test(n);
    // Transportauftrag in anderem Layout (früheres System, Auftrag eines Dritten): Überschrift oben, keine Rechnungsnummer –
    // solche Seiten nennen oft „Rechnung“, USt und Zahlungsziel und sähen sonst wie eine Rechnung aus. Nur als Vorschlag.
    if (T_FREMD.test(n.slice(0, 300)) && !nummer) {
      erg.push({ art: 'T', sicher: false, grund: 'vermutlich ein Transportauftrag (anderes Layout)' });
    } else if (wort && (r >= 4 || (r >= 3 && (!a || nummer)))) {
      erg.push({ art: 'R', sicher: true, grund: `Rechnung (${r} Merkmale)` });
    } else if (wort && r >= 3) {
      // „Lieferschein … Rechnung folgt“ mit Fußzeile (USt-IdNr., IBAN): eher Beleg, aber nicht eindeutig
      erg.push({ art: 'A', sicher: false, grund: 'unklar (Beleg mit Rechnungsmerkmalen) – als Ablieferbeleg vorgeschlagen' });
    } else if (nachR && !a && r >= 2 && (summe || SEITE_N.test(n))) {
      erg.push({ art: 'R', sicher: true, grund: 'Folgeseite der Rechnung (Summen/Zahlungsangaben)' });
    } else if (nachR && !a && (r >= 1 || SEITE_N.test(n))) {
      erg.push({ art: 'R', sicher: false, grund: 'vermutlich Folgeseite der Rechnung' });
    } else if (a) {
      erg.push({ art: 'A', sicher: true, merkmal: true, grund: 'Ablieferbeleg (Lieferschein, CMR, Empfangsbestätigung …)' });
    } else if (r === 0 && !(nachR && n.length > 400)) {
      erg.push({ art: 'A', sicher: true, grund: n.length < 40 ? 'Ablieferbeleg (Scan ohne lesbaren Text)' : 'Ablieferbeleg (weder Rechnung noch Transportauftrag)' });
    } else {
      erg.push({ art: 'A', sicher: false, grund: r ? `unklar (${r} Rechnungsmerkmal${r === 1 ? '' : 'e'}) – als Ablieferbeleg vorgeschlagen` : 'unklar (viel Text nach der Rechnung) – als Ablieferbeleg vorgeschlagen' });
    }
  }
  return erg;
}

// ---------------------------------------------------------------- Aufteilung

export interface Aufteilung {
  /** Seitennummern (ab 1) je Teil */
  rechnung: number[];
  ablieferbelege: number[];
  transportauftrag: number[];
  /** es gibt etwas zu trennen: Rechnung zusammen mit Ablieferbelegen und/oder Transportauftrag, oder Transportauftrag mit Belegen */
  noetig: boolean;
  /** jede Seite eindeutig → ohne Rückfrage aufteilen */
  sicher: boolean;
  /** Rolle des ganzen Dokuments; null = weder Rechnung noch Transportauftrag noch erkennbarer Ablieferbeleg (z. B. eine Bestellung) */
  rolle: 'rechnung' | 'ablieferbeleg' | 'transportauftrag' | null;
}

export function aufteilung(seiten: Pick<Seite, 'art' | 'sicher' | 'merkmal'>[]): Aufteilung {
  const nr = (art: Seitenart) => seiten.map((s, i) => (s.art === art ? i + 1 : 0)).filter(Boolean);
  const rechnung = nr('R'), ablieferbelege = nr('A'), transportauftrag = nr('T');
  const arten = [rechnung, ablieferbelege, transportauftrag].filter((x) => x.length).length;
  return {
    rechnung, ablieferbelege, transportauftrag,
    noetig: arten > 1,
    sicher: seiten.length > 0 && seiten.every((s) => s.sicher),
    rolle: rechnung.length ? 'rechnung' : transportauftrag.length && !ablieferbelege.length ? 'transportauftrag'
      : transportauftrag.length || seiten.some((x) => x.merkmal) ? 'ablieferbeleg' : null,
  };
}

/** „1–3, 5“ */
export function seitenText(seiten: number[]): string {
  const s = [...new Set(seiten)].sort((a, b) => a - b);
  const teile: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    teile.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return teile.join(', ');
}

/** Dateiname eines Teils: „Scan.pdf“ → „Scan – Rechnung.pdf“ */
export function teilDateiname(datei: string, teil: 'rechnung' | 'ablieferbeleg'): string {
  const stamm = datei.replace(/\.pdf$/i, '');
  return `${stamm} – ${teil === 'rechnung' ? 'Rechnung' : 'Ablieferbelege'}.pdf`;
}

/** Hinweis am Original nach dem Aufteilen */
export function aufteilungText(a: Aufteilung): string {
  const teile = [
    a.rechnung.length ? `Rechnung (S. ${seitenText(a.rechnung)})` : '',
    a.ablieferbelege.length ? `Ablieferbelege (S. ${seitenText(a.ablieferbelege)})` : '',
  ].filter(Boolean).join(' und ');
  return `Original (unverändert) – aufgeteilt in ${teile || 'nichts'}${a.transportauftrag.length ? `; eigener Transportauftrag (S. ${seitenText(a.transportauftrag)}) entfernt` : ''}.`;
}

// ---------------------------------------------------------------- Firmierung

export interface FruehereFirmierung { name: string; ustid: string }
export interface FirmaAngaben { name: string; strasse: string; plz: string; ort: string; ustid: string }
export type FirmierungErgebnis = 'ok' | 'alt' | 'unklar';
export interface Firmierung {
  ergebnis: FirmierungErgebnis;
  /** ein Satz für die Prüfliste */
  text: string;
  /** gefundene frühere Firmierung (bei ergebnis 'alt') */
  alt?: string;
}

/** alle Wörter in dieser Reihenfolge, höchstens `luecke` fremde Wörter dazwischen (Zeilenumbruch, „Inh.“, „z. Hd.“) */
function woerterNah(heu: string[], nadel: string[], luecke = 2): boolean {
  if (!nadel.length) return false;
  for (let i = 0; i < heu.length; i++) {
    if (heu[i] !== nadel[0]) continue;
    let pos = i, ok = true;
    for (let k = 1; k < nadel.length && ok; k++) {
      const bis = Math.min(heu.length - 1, pos + 1 + luecke);
      let gefunden = -1;
      for (let j = pos + 1; j <= bis; j++) if (heu[j] === nadel[k]) { gefunden = j; break; }
      if (gefunden < 0) ok = false; else pos = gefunden;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Name im Text. streng (aktuelle Firmierung): die Wörter des Namens direkt hintereinander. Sonst (frühere Firmierung, großzügig):
 * in der Reihenfolge des Namens mit bis zu zwei fremden Wörtern dazwischen („Inh.“, Zeilenumbruch) oder – bei mehreren Wörtern –
 * in beliebiger Reihenfolge dicht beieinander („Euroflex Benjamin Hartyniuk“).
 */
export function nameImText(textNormal: string, name: string, streng = false): boolean {
  const nadel = normal(name).split(' ').filter(Boolean);
  if (!nadel.length) return false;
  const heu = textNormal.split(' ');
  if (woerterNah(heu, nadel, streng ? 0 : 2)) return true;
  if (streng || nadel.length < 2) return false;
  const fenster = nadel.length + 3;
  for (let i = 0; i < heu.length; i++) {
    if (!nadel.includes(heu[i])) continue;
    const ausschnitt = heu.slice(i, i + fenster);
    if (nadel.every((w) => ausschnitt.includes(w))) return true;
  }
  return false;
}

const ustidImText = (text: string, ustid: string) => {
  const u = ustidNormal(ustid);
  return u.length >= 8 && ustidNormal(text).includes(u);
};

/**
 * Rechnungsempfänger prüfen. text: Text der Rechnungsseiten. Reihenfolge der Entscheidung:
 *  1. USt-IdNr. einer früheren Firmierung steht auf der Rechnung                    → alt
 *  2. aktueller Firmenname gefunden                                                  → ok (PLZ fehlt → unklar)
 *  3. Name einer früheren Firmierung gefunden, der aktuelle nicht                    → alt
 *  4. sonst                                                                          → unklar
 * Wörter, die frühere und aktuelle Firmierung gemeinsam haben, machen nichts aus: verglichen wird jeweils der ganze Name.
 */
export function firmierungPruefen(text: string, firma: FirmaAngaben, fruehere: FruehereFirmierung[]): Firmierung {
  const n = normal(text);
  const aktuell = normal(firma.name);
  if (!aktuell) return { ergebnis: 'unklar', text: 'Firmierung nicht geprüft: In den Stammdaten (Firma) fehlt der Firmenname.' };
  if (n.length < 20) return { ergebnis: 'unklar', text: 'Firmierung nicht geprüft: Auf der Rechnung ist kein Text lesbar.' };
  const alte = fruehere.filter((f) => normal(f.name) && normal(f.name) !== aktuell);
  const eigeneUstid = ustidNormal(firma.ustid);

  const altUstid = fruehere.find((f) => ustidNormal(f.ustid) && ustidNormal(f.ustid) !== eigeneUstid && ustidImText(text, f.ustid));
  if (altUstid) {
    return { ergebnis: 'alt', alt: altUstid.name || altUstid.ustid, text: `Rechnung an die frühere Firmierung: USt-IdNr. ${altUstid.ustid.trim()}${altUstid.name ? ` („${altUstid.name.trim()}“)` : ''} steht auf der Rechnung.` };
  }
  const nameOk = nameImText(n, firma.name, true);
  // steckt der aktuelle Name im früheren (oder umgekehrt), entscheidet der längere
  const altName = alte
    .filter((f) => nameImText(n, f.name))
    .find((f) => !nameOk || normal(f.name).length > aktuell.length && normal(f.name).includes(aktuell));
  if (altName) return { ergebnis: 'alt', alt: altName.name.trim(), text: `Rechnung an die frühere Firmierung „${altName.name.trim()}“ statt „${firma.name.trim()}“.` };
  if (nameOk) {
    const plz = normal(firma.plz);
    if (plz && !n.split(' ').includes(plz)) return { ergebnis: 'unklar', text: `Firmenname stimmt, aber die Anschrift (PLZ ${firma.plz.trim()}) steht nicht auf der Rechnung – bitte prüfen.` };
    return { ergebnis: 'ok', text: `Rechnungsempfänger stimmt („${firma.name.trim()}“).` };
  }
  if (eigeneUstid && ustidImText(text, firma.ustid)) {
    return { ergebnis: 'unklar', text: `Eigene USt-IdNr. gefunden, aber der Firmenname „${firma.name.trim()}“ nicht – bitte den Empfänger prüfen.` };
  }
  return { ergebnis: 'unklar', text: `Firmenname „${firma.name.trim()}“ nicht auf der Rechnung gefunden – bitte den Empfänger prüfen.` };
}

/** Text der Reklamation an den Rechnungssteller (Entwurf im Postfach) */
export function reklamationMail(q: { betreff: string; firma: FirmaAngaben; alt: string | null }): { betreff: string; text: string } {
  const f = q.firma;
  const anschrift = [f.name.trim(), f.strasse.trim(), `${f.plz} ${f.ort}`.trim(), f.ustid.trim() ? `USt-IdNr.: ${f.ustid.trim()}` : ''].filter(Boolean).join('\n');
  const betreff = q.betreff.trim().replace(/^((aw|re|wg|fwd?|wtr)\s*:\s*)+/i, '').trim();
  return {
    betreff: `Bitte um Rechnungskorrektur${betreff ? ` – ${betreff}` : ''}`.slice(0, 250),
    text: [
      'Sehr geehrte Damen und Herren,',
      '',
      `vielen Dank für Ihre Rechnung. Sie ist noch an unsere frühere Firmierung${q.alt ? ` „${q.alt}“` : ''} adressiert und kann so nicht gebucht werden.`,
      '',
      'Bitte stellen Sie die Rechnung neu aus auf:',
      '',
      anschrift,
      '',
      'Bitte hinterlegen Sie diese Daten auch in Ihren Stammdaten, damit künftige Rechnungen richtig adressiert sind.',
      '',
      'Vielen Dank und freundliche Grüße',
      f.name.trim(),
    ].join('\n'),
  };
}
