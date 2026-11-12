/**
 * Kontakterkennung (#158): eingefügten oder abgelegten Text (E-Mail-Signatur, Impressum, Briefkopf, Visitenkarte .vcf,
 * Text aus einem Screenshot oder PDF, z. B. Unternehmensprofil einer Frachtenbörse) analysieren und als Vorschlag auf die
 * Felder des Kontakts verteilen. Reine Textanalyse ohne Fremddienste –
 * nichts wird gespeichert; der Anwender prüft die Vorschläge und übernimmt sie in den Dialog.
 */
export interface KontaktFelder {
  kundenname?: string; kundenname2?: string; anrede?: string; vorname?: string; name?: string; strasse?: string; hausnummer?: string;
  land?: string; plz?: string; ort?: string; telefon?: string; fax?: string; email?: string; gln?: string; ustid?: string;
}
export interface Erkennung { felder: KontaktFelder; /** Zeilen, die keinem Feld zugeordnet wurden */ unklar: string[]; hinweise: string[] }

const MAX: Record<keyof KontaktFelder, number> = {
  kundenname: 60, kundenname2: 60, anrede: 20, vorname: 40, name: 40, strasse: 60, hausnummer: 10, land: 3, plz: 10, ort: 40,
  telefon: 30, fax: 30, email: 128, gln: 20, ustid: 20,
};
const LAND_NAME: Record<string, string> = {
  deutschland: 'DE', germany: 'DE', allemagne: 'DE', österreich: 'AT', oesterreich: 'AT', austria: 'AT', schweiz: 'CH', switzerland: 'CH', suisse: 'CH',
  frankreich: 'FR', france: 'FR', luxemburg: 'LU', luxembourg: 'LU', belgien: 'BE', belgium: 'BE', belgique: 'BE', belgië: 'BE',
  niederlande: 'NL', netherlands: 'NL', nederland: 'NL', holland: 'NL', italien: 'IT', italy: 'IT', italia: 'IT', polen: 'PL', poland: 'PL', polska: 'PL',
  tschechien: 'CZ', 'czech republic': 'CZ', dänemark: 'DK', denmark: 'DK', spanien: 'ES', spain: 'ES', españa: 'ES', ungarn: 'HU', hungary: 'HU',
  slowakei: 'SK', slowenien: 'SI', kroatien: 'HR', rumänien: 'RO', bulgarien: 'BG', schweden: 'SE', sweden: 'SE', portugal: 'PT',
  'vereinigtes königreich': 'GB', 'united kingdom': 'GB', großbritannien: 'GB', england: 'GB', liechtenstein: 'LI',
};
const LAND_KURZ: Record<string, string> = {
  D: 'DE', DE: 'DE', A: 'AT', AT: 'AT', CH: 'CH', F: 'FR', FR: 'FR', L: 'LU', LU: 'LU', B: 'BE', BE: 'BE', NL: 'NL', I: 'IT', IT: 'IT', PL: 'PL',
  CZ: 'CZ', DK: 'DK', E: 'ES', ES: 'ES', H: 'HU', HU: 'HU', SK: 'SK', SI: 'SI', HR: 'HR', RO: 'RO', BG: 'BG', S: 'SE', SE: 'SE', P: 'PT', PT: 'PT', FL: 'LI', LI: 'LI',
  BG: 'BG', GR: 'GR', LT: 'LT', LV: 'LV', EE: 'EE', FI: 'FI', NO: 'NO', IE: 'IE', GB: 'GB', UK: 'GB', UA: 'UA', RS: 'RS', TR: 'TR', MK: 'MK', AL: 'AL',
  BA: 'BA', ME: 'ME', MD: 'MD', BY: 'BY', CY: 'CY', MT: 'MT', IS: 'IS', XK: 'XK',
};
/** Überschriften aus Profilen und Formularen (z. B. Frachtenbörse): keine Inhalte, aber Hinweis auf die folgende Zeile */
const KOPF = /^(timocom|unternehmensprofil(\s+details)?|firmenprofil|profil|details|kontakt(daten|informationen)?|contact|anschrift|hausanschrift|postanschrift|rechnungsanschrift|lieferanschrift|adresse|address|erreichbarkeit|stammdaten)$/i;
const KOPF_FIRMA = /^(unternehmen|firma|firmenname|company|unternehmensname|name des unternehmens)$/i;
const FIRMA = /\b(gmbh|mbh|ag|kg|ohg|ug|gbr|se|e\.\s?k\.|e\.\s?v\.|eg|kgaa|ltd\.?|limited|inc\.?|llc|b\.\s?v\.|n\.\s?v\.|s\.\s?a\.|s\.\s?a\.\s?r\.\s?l\.|sarl|sas|s\.\s?r\.\s?l\.|s\.\s?p\.\s?a\.|sp\.\s?z\s?o\.\s?o\.|s\.\s?r\.\s?o\.|a\.\s?s\.|aps|a\/s|ab|oy|d\.\s?o\.\s?o\.|e?ood|ead|kft|zrt|srl|sia|uab|oü|bvba|nv|s\.\s?l\.|lda|k\.\s?s\.|j\.\s?d\.\s?o\.\s?o\.|doo|ltda?)(?=$|[\s,.)&])/i;
const FIRMA_WORT = /(spedition|transporte?\b|logisti[kc]s?|trucking|fracht|cargo|handel|handels|service|group|gruppe|holding|\bbau\b|technik|systems?|solutions|werke?\b|zentrum|center|verein|\bclub\b|express|trans\b|gesellschaft|company|\bco\.)/i;
const GRUSS = /^(mit\s+(freundliche[nm]|beste[nm]|herzliche[nm])|freundliche|viele|beste|liebe|herzliche|sonnige|sportliche)\s+gr[üu](ß|ss)e?n?\b|^(best|kind|warm)\s+regards|^regards\b|^mfg\b|^vg\b|^lg\b|^--+\s*$|^_{3,}$|^i\.\s?[av]\.\s*$|^(sehr geehrte|hallo|guten (tag|morgen)|dear)\b/i;
const FUSS = /^(gesch[äa]ftsf[üu]hr|amtsgericht|registergericht|handelsregister|hrb?\b|hra\b|sitz\b|steuer-?n|st\.?-?nr|iban|bic|swift|bank|sparkasse|volksbank|www[\s.]|https?:|web\b|internet\b|homepage\b|vorstand|aufsichtsrat|inhaber|pers[öo]nlich haftend)/i;
const POSITION = /(gesch[äa]ftsf|disponent|disposition|vertrieb|verkauf|einkauf|sales|manager|leiter|leitung|assisten|sachbearbeit|buchhaltung|prokurist|director|head of|\bceo\b|\bcfo\b|\bcoo\b|\bteam\b|abteilung|kundenservice|customer|account|fuhrpark|lager\b|projekt)/i;
const TITEL = /\b(dr|prof|dipl|ing|mag|med|rer|nat|jur|phil|h\.\s?c|b\.\s?a|m\.\s?a|b\.\s?sc|m\.\s?sc|mba|kfm|betriebsw|wirt)\b[.-]*(\s?\([a-z]+\))?/gi;
const PARTIKEL = /^(von|van|de|der|den|del|della|di|du|la|le|zu|zur|vom|ten|ter)$/i;

const sauber = (s: string) => s.replace(/\s+/g, ' ').trim();
const gleich = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
const ziffern = (s: string) => s.replace(/\D/g, '');
function telefon(s: string): string | null {
  const t = sauber(s.replace(/[^\d+()\/\s.-]/g, ' ').replace(/\(0\)/g, '(0)'));
  return ziffern(t).length >= 6 && ziffern(t).length <= 17 ? t : null;
}

/** „Musterstraße 12 a“ → Straße und Hausnummer (auch „12 rue de la Gare“) */
export function strasseTeilen(z: string): { strasse: string; hausnummer?: string } {
  const s = sauber(z);
  let m = /^(\d+\s?[a-z]?(?:\s?(?:bis|ter))?),?\s+((?:rue|avenue|av\.|boulevard|bd\.?|chemin|route|place|all[ée]e|impasse|quai|via|viale|piazza|calle|ul\.|ulica)\b.+)$/i.exec(s);
  if (m) return { strasse: m[2], hausnummer: m[1] };
  m = /^(.*?[^\d\s,])[\s,]+(\d+\s?[a-z]?(?:\s?[-\/+]\s?\d+\s?[a-z]?)?)$/i.exec(s);
  if (m && m[2].length <= 10) return { strasse: m[1].replace(/[,\s]+$/, ''), hausnummer: m[2].replace(/\s+/g, ' ') };
  return { strasse: s };
}
const PLZ_ORT = /^(?:([A-Z]{1,3})\s?[-–]\s?)?(\d{5}|\d{4}\s?[A-Z]{2}|\d{2}-\d{3}|\d{4})\s+([A-Za-zÀ-ž(].*)$/;
const STRASSE = /(stra(ß|ss)e|str\.|weg|platz|allee|gasse|ring|damm|ufer|chaussee|pfad|steig|graben|wall|laan|straat|postfach|rue |avenue|via |road|street)\b|(?:^|\s)(am|an der|im|in der|auf dem|zum|zur)\s/i;

function person(z: string): Pick<KontaktFelder, 'anrede' | 'vorname' | 'name'> | null {
  let s = sauber(z.split(/\s[-–|]\s/)[0]);
  const f: Pick<KontaktFelder, 'anrede' | 'vorname' | 'name'> = {};
  const a = /^(herrn?|frau|mr\.?|mrs\.?|ms\.?|monsieur|madame|m\.|mme\.?)\s+(.+)$/i.exec(s);
  if (a) { f.anrede = /^(herr|mr|monsieur|m\.)/i.test(a[1]) ? 'Herr' : 'Frau'; s = a[2]; }
  s = sauber(s.replace(TITEL, ' ').replace(/\s[.,]\s/g, ' ').replace(/^[.,\s-]+/, ''));
  const komma = /^([^,]+),\s*([^,]+)$/.exec(s);
  let teile = komma ? [...komma[2].split(' '), ...komma[1].split(' ')] : s.split(' ');
  teile = teile.filter(Boolean);
  if (!teile.length || teile.length > 5 || teile.some((t) => /\d|@/.test(t))) return a ? f : null;
  if (teile.length === 1) { f.name = teile[0]; return f; }
  let ab = teile.length - 1;
  while (ab > 1 && PARTIKEL.test(teile[ab - 1])) ab--;
  f.vorname = teile.slice(0, ab).join(' ');
  f.name = teile.slice(ab).join(' ');
  return f;
}
const namensartig = (z: string) => {
  const w = sauber(z.replace(TITEL, ' ')).split(' ').filter(Boolean);
  return w.length >= 2 && w.length <= 4 && !/\d|@|:/.test(z) && !FIRMA.test(z) && !FIRMA_WORT.test(z) && !POSITION.test(z) && !STRASSE.test(z)
    // Wörter wie Namen: groß begonnen mit Kleinbuchstaben, Initiale („J.“) oder Großschrift ab drei Buchstaben – keine Logo-Reste wie „B ST“
    && w.every((x) => /^[A-ZÀ-Þ]\p{Ll}[\p{L}'’.-]*$/u.test(x) || /^[A-ZÀ-Þ]\.$/u.test(x) || /^[A-ZÀ-Þ]{3,}$/u.test(x) || PARTIKEL.test(x));
};

function vcard(text: string): Erkennung {
  const f: KontaktFelder = {};
  const unklar: string[] = [];
  let mobil = '';
  const zeilen = text.replace(/\n[ \t]/g, '').split('\n').map((z) => z.trim()).filter(Boolean);
  const wert = (v: string) => v.split(/(?<!\\);/).map((x) => sauber(x.replace(/\\n/gi, ' ').replace(/\\([,;])/g, '$1')));
  for (const z of zeilen) {
    const m = /^(?:[\w-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/.exec(z);
    if (!m) continue;
    const [, key, par, roh] = m;
    const v = wert(roh);
    switch (key.toUpperCase()) {
      case 'ORG': if (v[0]) f.kundenname = v[0]; if (v[1]) f.kundenname2 = v[1]; break;
      case 'N': if (v[0]) f.name = v[0]; if (v[1]) f.vorname = v[1]; if (/^(herr|mr)/i.test(v[3] ?? '')) f.anrede = 'Herr'; else if (/^(frau|mrs|ms)/i.test(v[3] ?? '')) f.anrede = 'Frau'; break;
      case 'FN': if (!f.name) Object.assign(f, person(v[0]) ?? {}); break;
      case 'EMAIL': f.email ??= v[0]; break;
      case 'TEL': {
        const t = telefon(v[0].replace(/^tel:/i, ''));
        if (!t) break;
        if (/fax/i.test(par)) f.fax ??= t; else if (/cell|mobile/i.test(par)) mobil ||= t; else f.telefon ??= t;
        break;
      }
      case 'ADR': {
        if (f.ort || f.strasse) break;
        if (v[2]) Object.assign(f, strasseTeilen(v[2]));
        if (v[3]) f.ort = v[3];
        if (v[5]) f.plz = v[5];
        const l = (v[6] ?? '').trim();
        if (l) f.land = LAND_NAME[l.toLowerCase()] ?? (l.length <= 3 ? LAND_KURZ[l.toUpperCase()] ?? l.toUpperCase() : undefined);
        break;
      }
      default:
    }
  }
  if (mobil) { if (!f.telefon) f.telefon = mobil; else unklar.push(`Mobil: ${mobil}`); }
  return { felder: f, unklar, hinweise: [] };
}

export function kontaktErkennen(roh: string): Erkennung {
  const text = roh.replace(/\r/g, '').replace(/[   ]/g, ' ').slice(0, 20000);
  return fertig(/BEGIN:VCARD/i.test(text) ? vcard(text) : frei(text));
}

function fertig(e: Erkennung): Erkennung {
  let f = e.felder;
  // nur ein Name ohne jede Anschrift/Erreichbarkeit und ohne Rechtsform: kein Kontakt (z. B. beliebiger Fließtext)
  if (![f.email, f.telefon, f.fax, f.plz, f.strasse, f.ustid, f.gln].some(Boolean) && !(f.kundenname && FIRMA.test(f.kundenname))) {
    e.unklar.unshift(...Object.values(f).filter((v): v is string => !!v));
    f = e.felder = {};
  }
  if (!f.kundenname && (f.vorname || f.name)) f.kundenname = sauber(`${f.vorname ?? ''} ${f.name ?? ''}`);
  if (f.email) f.email = f.email.toLowerCase();
  if (!f.land && f.plz && /^\d{5}$/.test(f.plz)) f.land = 'DE';
  for (const k of Object.keys(f) as (keyof KontaktFelder)[]) {
    const v = sauber(f[k] ?? '');
    if (!v) delete f[k]; else f[k] = v.slice(0, MAX[k]);
  }
  if (!Object.keys(f).length) e.hinweise.push('Im Text wurden keine Kontaktdaten erkannt.');
  else {
    if (!f.kundenname) e.hinweise.push('Kein Firmenname erkannt – bitte den Namen ergänzen.');
    if (f.plz && !f.land) e.hinweise.push('Das Land konnte nicht bestimmt werden – bitte prüfen.');
  }
  e.unklar = [...new Set(e.unklar.map(sauber).filter(Boolean))].slice(0, 12);
  return e;
}

function frei(text: string): Erkennung {
  const f: KontaktFelder = {};
  // Zeilen: Trenner | • · und Tabulator, mehrere Angaben je Zeile (Tel … Fax …), Anschrift mit Kommas
  let zeilen = text.split('\n').flatMap((z) => z.split(/\s+[|•·▪●]\s+|\t+|\s{4,}/))
    .flatMap((z) => z.split(/\s+(?=(?:t[eé]l(?:[eé]phone|efon)?|fon|phone|fax|telefax|mobil|mobile|handy|e-?mail|ust\.?-?\s?id\w*\.?|vat\b)[\s.:-])/i))
    .map(sauber).filter(Boolean);
  zeilen = zeilen.flatMap((z) => {
    const teile = z.split(/\s*,\s*/);
    return teile.length > 1 && teile.some((t) => PLZ_ORT.test(t)) ? teile : [z];
  }).filter((z) => !GRUSS.test(z));
  // Texterkennung: Symbole vor Angaben (Telefon-/Brief-Icon als „@“, „®“, „&“ gelesen) und leere Reste entfernen
  zeilen = zeilen.map((z) => sauber(z.replace(/^(?:[^\p{L}\p{N}+(]+|[^\p{L}\p{N}\s]\s+|[a-z]\s+(?=\+?\d[\d\s()\/.-]{6,}$))+/u, ''))).filter((z) => /[\p{L}\p{N}]/u.test(z));
  // Überschriften (Unternehmen, Hausanschrift …) entfernen; die Zeile nach „Unternehmen“/„Firma“ ist der Firmenname
  let nachFirma = false;
  let iHinweis = -1;
  const ohneKopf: string[] = [];
  for (const z of zeilen) {
    if (KOPF_FIRMA.test(z)) { nachFirma = true; continue; }
    if (KOPF.test(z)) continue;
    if (nachFirma && iHinweis < 0 && !FUSS.test(z) && !/@|^\+?[\d\s()\/.-]{7,}$/.test(z) && !/^(tc\s?id|ust|vat|uid|tel|fax|mobil)/i.test(z)) iHinweis = ohneKopf.length;
    ohneKopf.push(z);
  }
  zeilen = ohneKopf;
  // „Ansprechpartner: Frau Dr. Probe“, „z. Hd. …“, „t.a.v. …“: Beschriftung entfernen, Zeile als Person vormerken
  const AN = /^(?:ihre?\s+)?(?:ansprechpartner(?:in)?|kontaktperson|kontakt|contact|z\.\s?hd\.?|zu\s+h[äa]nden(?:\s+von)?|t\.\s?a\.\s?v\.|attn\.?|att\.|c\/o)\s*[:.]?\s+(?=\S)/i;
  const anPerson = new Set<number>();
  zeilen = zeilen.map((z, i) => { if (AN.test(z) && !/@/.test(z)) { anPerson.add(i); return sauber(z.replace(AN, '')); } return z; });
  const frei = zeilen.map(() => true);
  const nimm = (i: number) => { frei[i] = false; };
  let mobil = '';

  // 1. E-Mail, beschriftete Angaben, USt-IdNr.
  zeilen.forEach((z, i) => {
    // Texterkennung verliert gelegentlich den Punkt vor der Endung („name@firma com“)
    z = zeilen[i] = z.replace(/([\w.+-]+@[\w-]+(?:\.[\w-]+)*) (com|de|net|org|eu|info|biz|at|ch|fr|nl|be|lu|pl|it|es|cz|bg|ro|hu|dk)$/i, '$1.$2');
    const mail = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(z);
    if (mail) {
      f.email ??= mail[0];
      const rest = sauber(z.replace(mail[0], '').replace(/^(e-?mail|mail|e)\s*[.:]*/i, '').replace(/[<>()[\]]/g, ''));
      if (rest.length < 3 || /^(e-?mail|mail)$/i.test(rest)) nimm(i);
      else zeilen[i] = rest;
      if (!frei[i]) return;
      z = zeilen[i];
    }
    const m = /^(telefon|tel|t[ée]l[ée]phone|t[ée]l|fon|phone|mobil|mobile|mobiltelefon|handy|fax|telefax|ust\.?\s?-?\s?id\.?\s?-?\s?(?:nr)?\.?|umsatzsteuer-?id(?:entifikationsnummer)?|vat(?:\s?(?:id|no|reg))?\.?|uid|gln|iln|zentrale|durchwahl|direkt|büro|office)\s*(?:nr|nummer|no)?\s*[.:#-]*\s+(.+)$/i.exec(z)
      ?? /^([tmfp])\s*[.:]+\s*(.+)$/i.exec(z);
    if (m) {
      const l = m[1].toLowerCase();
      if (/^(ust|umsatz|vat|uid)/.test(l)) { f.ustid ??= m[2].replace(/[\s.-]/g, '').toUpperCase(); nimm(i); return; }
      if (/^(gln|iln)/.test(l)) { if (ziffern(m[2]).length === 13) f.gln ??= ziffern(m[2]); nimm(i); return; }
      const t = telefon(m[2]);
      if (t) {
        if (/^(fax|telefax|f)$/.test(l)) f.fax ??= t; else if (/^(mobil|mobile|mobiltelefon|handy|m)$/.test(l)) mobil ||= t; else f.telefon ??= t;
        nimm(i);
      }
      return;
    }
    const u = /\b(DE\s?\d{9}|ATU\s?\d{8})\b/.exec(z);
    if (u && !/iban/i.test(z)) { f.ustid ??= u[1].replace(/\s/g, ''); if (sauber(z.replace(u[0], '')).length < 4) nimm(i); }
  });

  // 2. PLZ und Ort, Land
  let iPlz = -1;
  zeilen.forEach((z, i) => {
    if (!frei[i]) return;
    const l = LAND_NAME[z.toLowerCase()] ?? (/^[A-Z]{2}$/.test(z) ? LAND_KURZ[z] : undefined);
    if (l) { if (/^[A-Z]{2}$/.test(z)) f.land = l; else f.land ??= l; nimm(i); return; }
    const m = PLZ_ORT.exec(z);
    if (m && iPlz < 0 && !STRASSE.test(m[3].split(' ')[0] + ' ')) {
      iPlz = i;
      f.plz = m[2];
      let ort = m[3];
      const letzt = ort.split(' ').pop()!.toLowerCase();
      if (LAND_NAME[letzt] && ort.includes(' ')) { f.land ??= LAND_NAME[letzt]; ort = ort.slice(0, ort.lastIndexOf(' ')); }
      f.ort = ort.replace(/[,;]+$/, '');
      if (m[1] && LAND_KURZ[m[1]]) f.land = LAND_KURZ[m[1]];
      else if (/^\d{4}\s?[A-Z]{2}$/.test(m[2])) f.land ??= 'NL';
      else if (/^\d{2}-\d{3}$/.test(m[2])) f.land ??= 'PL';
      nimm(i);
    }
  });

  // 3. Straße: die Zeile vor PLZ/Ort, sonst eine Zeile, die wie eine Straße aussieht
  let vor = iPlz - 1;
  while (vor >= 0 && vor >= iPlz - 2 && !frei[vor]) vor--;
  let iStr = vor >= 0 && vor >= iPlz - 2 && iPlz >= 0 && frei[vor] && !FIRMA.test(zeilen[vor]) && vor !== iHinweis && (/\d/.test(zeilen[vor]) || STRASSE.test(zeilen[vor])) ? vor : -1;
  if (iStr < 0) iStr = zeilen.findIndex((z, i) => frei[i] && STRASSE.test(z) && /\d/.test(z) && !FIRMA.test(z) && !FUSS.test(z));
  if (iStr >= 0) { Object.assign(f, strasseTeilen(zeilen[iStr])); nimm(iStr); }

  // 4. Fußzeilen (Handelsregister, Bank, Internet) und Stellenbezeichnungen bleiben unzugeordnet
  const rest = (i: number) => frei[i] && !FUSS.test(zeilen[i]);
  const firmaOk = (i: number) => rest(i) && !anPerson.has(i);
  // 5. Firma: Zeile mit Rechtsform, sonst mit typischem Firmenwort
  // Firma: Zeile mit Rechtsform, sonst die Zeile nach der Überschrift „Unternehmen“/„Firma“, sonst ein typisches Firmenwort
  let iFirma = zeilen.findIndex((z, i) => firmaOk(i) && FIRMA.test(z) && !POSITION.test(z.replace(FIRMA, '')));
  if (iFirma < 0) iFirma = zeilen.findIndex((z, i) => firmaOk(i) && FIRMA.test(z));
  if (iFirma < 0 && iHinweis >= 0 && firmaOk(iHinweis)) iFirma = iHinweis;
  if (iFirma < 0) iFirma = zeilen.findIndex((z, i) => firmaOk(i) && FIRMA_WORT.test(z) && !POSITION.test(z) && !/\d{3}/.test(z));
  if (iFirma >= 0) { f.kundenname = zeilen[iFirma]; nimm(iFirma); }

  // 6. Ansprechpartner: Anrede, sonst passend zur E-Mail-Adresse, sonst eine Zeile, die wie ein Name aussieht
  let iPers = zeilen.findIndex((_, i) => rest(i) && anPerson.has(i));
  if (iPers < 0) iPers = zeilen.findIndex((z, i) => rest(i) && /^(herrn?|frau|mr\.?|mrs\.?|ms\.?|monsieur|madame)\s+\S/i.test(z));
  if (iPers < 0 && f.email) {
    const teile = gleich(f.email.split('@')[0]).split(/[._-]+/).filter((t) => t.length >= 3 && /^[a-z]+$/.test(t));
    if (teile.length) iPers = zeilen.findIndex((z, i) => rest(i) && !POSITION.test(z) && !/\d/.test(z) && teile.every((t) => gleich(z).split(/[^a-z]+/).includes(t)));
  }
  if (iPers < 0) iPers = zeilen.findIndex((z, i) => rest(i) && namensartig(z) && (iFirma >= 0 || zeilen.some((x, k) => k !== i && rest(k) && !POSITION.test(x) && (iStr < 0 || k < iStr))));
  if (iPers < 0 && iFirma < 0) iPers = zeilen.findIndex((z, i) => rest(i) && namensartig(z));
  if (iPers >= 0) { const p = person(zeilen[iPers]); if (p) { Object.assign(f, p); nimm(iPers); } }

  // 7. ohne erkannte Firma: erste übrige Zeile oberhalb der Anschrift
  if (iFirma < 0) {
    iFirma = zeilen.findIndex((z, i) => rest(i) && !POSITION.test(z) && !/^\+?[\d\s()\/.-]{7,}$/.test(z) && (iStr < 0 || i < iStr) && (iPlz < 0 || i < iPlz));
    if (iFirma >= 0) { f.kundenname = zeilen[iFirma]; nimm(iFirma); }
  }
  // 8. Namenszusatz: Zeile direkt nach der Firma (z. B. Niederlassung), vor der Anschrift
  if (iFirma >= 0 && rest(iFirma + 1) && !POSITION.test(zeilen[iFirma + 1]) && !/@|\d{4}/.test(zeilen[iFirma + 1])
      && (iStr < 0 || iFirma + 1 < iStr) && (iPlz < 0 || iFirma + 1 < iPlz) && iStr !== -1) {
    f.kundenname2 = zeilen[iFirma + 1]; nimm(iFirma + 1);
  }
  // 9. unbeschriftete Telefonnummer
  zeilen.forEach((z, i) => { if (frei[i] && /^\+?[\d\s()\/.-]{7,}$/.test(z)) { const t = telefon(z); if (t) { if (!f.telefon) f.telefon = t; else mobil ||= t; nimm(i); } } });
  const unklar = zeilen.filter((_, i) => frei[i]);
  if (mobil) { if (!f.telefon) f.telefon = mobil; else if (mobil !== f.telefon) unklar.push(`Mobil: ${mobil}`); }
  return { felder: f, unklar, hinweise: [] };
}
