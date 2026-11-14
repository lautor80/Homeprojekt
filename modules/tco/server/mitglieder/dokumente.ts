import { BusinessError } from '../../../../server/src/errors.js';
import type { Paperless } from '../../../../server/src/lib/paperless.js';
import { paperless, plAktiv, type Verein } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { leer, normName } from './logik.js';
import { ART_DOKTYP, ART_TEXT, type Art } from './pdf.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/** Paperless-Anbindung der Mitgliederakte: Dokumente je Korrespondent „Nachname Vorname“, Ablage, Upload, Mailtexte */

export const SPEICHERPFAD = 'Mitglieder';
export const WA_COMMUNITY = 'https://chat.whatsapp.com/DXhJoiv5UgwEvpmFPD6Jjz';
export const WA_JUGEND = 'https://chat.whatsapp.com/LIjvLYmD0DAEuqaGlH8PM9';

export const korrName = (m: { nachname?: string | null; vorname?: string | null }) => condense(`${leer(m.nachname)} ${leer(m.vorname)}`);

export function plPruefen(v: Verein): Paperless {
  if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Schnittstellen → Anbindungen).');
  return paperless(v);
}

/** Korrespondent zum Mitglied (Vergleich ohne Umlaute/Akzente, beide Namensreihenfolgen) */
export async function korrespondentFinden(pl: Paperless, m: { nachname?: string | null; vorname?: string | null }) {
  const a = normName(`${leer(m.nachname)} ${leer(m.vorname)}`), b = normName(`${leer(m.vorname)} ${leer(m.nachname)}`);
  return (await pl.korrespondenten()).find((k) => [a, b].includes(normName(k.name))) ?? null;
}

export interface Dok { id: number; titel: string; erstellt: string; typ: string; notizen: number; datei: string; mime: string }

export async function dokumenteLesen(v: Verein, m: Record<string, any>) {
  const pl = plPruefen(v);
  const k = await korrespondentFinden(pl, m);
  if (!k) return { korrespondent: null, dokumente: [] as Dok[] };
  const typen = new Map((await pl.dokumenttypen()).map((t) => [t.id, t.name]));
  const docs = await pl.dokumenteSuchen({ correspondent__id: String(k.id), ordering: '-created', page_size: '100' });
  return {
    korrespondent: k,
    dokumente: docs.map((d): Dok => ({
      id: Number(d.id), titel: d.title ?? `Dokument ${d.id}`, erstellt: String(d.created_date ?? d.created ?? '').slice(0, 10),
      typ: typen.get(d.document_type) ?? '', notizen: Array.isArray(d.notes) ? d.notes.length : 0,
      datei: d.original_file_name ?? '', mime: d.mime_type ?? '',
    })),
  };
}

async function doktypName(pl: Paperless, art: Art): Promise<string> {
  if (art !== '5') return ART_DOKTYP[art];
  return (await pl.dokumenttypen()).find((t) => /SEPA|MANDAT/i.test(t.name))?.name ?? ART_DOKTYP[art];
}

/**
 * Unterlage nach Paperless: gleicher Titel (Art + Name) heute schon abgelegt → neue Version,
 * sonst neues Dokument mit Korrespondent, Dokumenttyp und Speicherpfad „Mitglieder“.
 */
export async function unterlageAblegen(v: Verein, art: Art, m: Record<string, any>, pdf: Buffer, benutzer: string) {
  const pl = plPruefen(v);
  const titel = condense(`${ART_TEXT[art]}_${leer(m.nachname)}_${leer(m.vorname)}`);
  const datei = `${titel}.pdf`;
  const warnungen: string[] = [];
  const k = await korrespondentFinden(pl, m);
  let id: number | null = null;
  let version = false;
  if (k) {
    const hit = (await pl.dokumenteSuchen({ correspondent__id: String(k.id), title__iexact: titel }).catch(() => []))
      .find((d) => String(d.created_date ?? d.created ?? '').slice(0, 10) === heute());
    if (hit) {
      id = Number(hit.id);
      const task = await pl.uploadVersion(id, pdf, datei, `Neudruck ${dat(heute())}`);
      await pl.warteAufDokument(task, 15).catch(() => null);
      version = true;
    }
  }
  if (!id) {
    // Felder laut zentraler Paperless-Zuordnung (Kontext „Mitglied – erzeugte Unterlage“)
    const r = await kontextAblegen(pl, K.mitgliedUnterlage, 'tco', {
      ...mitgliedWerte(m), art: ART_TEXT[art], doktyp: await doktypName(pl, art), heute: heute(), benutzer, verein: v.name,
    }, pdf, datei, { ueberschreiben: k ? { correspondent: k.name } : undefined });
    if (!r.id) throw new BusinessError('Hochgeladen, die Dokument-ID ist aber noch nicht verfügbar – bitte in einer Minute erneut ablegen.');
    id = r.id;
    warnungen.push(...r.warnungen);
  }
  const link = await pl.neuesteVersion(id).then((ver) => pl.freigabelink(ver, 30)).catch(() => '');
  return {
    id, link, warnungen,
    text: version ? `Heute bereits abgelegt – neue Version zu Paperless-Dokument ${id} erzeugt.` : `Nach Paperless übertragen (Dokument ${id})${link ? ', Freigabelink erzeugt' : ''}.`,
  };
}

/** Beliebige Datei in die Mitgliederakte (Dokumentdatum = heute, Speicherpfad „Mitglieder“, optional Notiz) */
export async function dateiAblegen(v: Verein, m: Record<string, any>, f: { datei: string; mime: string; inhalt: Buffer; titel: string; doktyp: number | null; notiz: string }, benutzer: string) {
  const pl = plPruefen(v);
  const k = await korrespondentFinden(pl, m);
  const doktyp = f.doktyp ? (await pl.dokumenttypen()).find((t) => t.id === f.doktyp)?.name ?? '' : '';
  // Felder laut zentraler Paperless-Zuordnung (Kontext „Mitglied – Datei ablegen“)
  const r = await kontextAblegen(pl, K.mitgliedDatei, 'tco', {
    ...mitgliedWerte(m), datei: f.datei, titel: f.titel || f.datei.replace(/\.[^.]+$/, ''), doktyp,
    notiz: f.notiz.trim() ? `${f.notiz.trim()} (${benutzer}, Vereinsportal)` : '', heute: heute(), benutzer, verein: v.name,
  }, f.inhalt, f.datei, { mime: f.mime, ueberschreiben: k ? { correspondent: k.name } : undefined });
  if (!r.id) return 'Die Datei liegt in Paperless, die Verarbeitung läuft noch. Bitte die Dokumente gleich aktualisieren.';
  return `„${f.titel || f.datei}“ in Paperless abgelegt (Dokument ${r.id}).${r.warnungen.length ? ` Hinweis: ${r.warnungen.join('; ')}` : ''}`;
}

/** Platzhalter des Mitglieds für die Paperless-Zuordnung */
export const mitgliedWerte = (m: Record<string, any>) => ({
  mitglied: korrName(m), vorname: leer(m.vorname), nachname: leer(m.nachname), adrnr: m.adrnr ?? '', mitglnr: m.mitglnrn ?? '',
});

export async function freigabelinks(v: Verein, ids: number[]): Promise<{ id: number; titel: string; link: string }[]> {
  const pl = plPruefen(v);
  pl.freigabeExternPflicht(); // die Links gehen an das Mitglied (E-Mail, WhatsApp, mailto): nie mit interner Adresse
  const out: { id: number; titel: string; link: string }[] = [];
  for (const id of ids) {
    const d = await pl.dokument(id);
    const ver = await pl.neuesteVersion(id).catch(() => id);
    out.push({ id, titel: d.title ?? `Dokument ${id}`, link: await pl.freigabelink(ver, 30) });
  }
  return out;
}

const KOPF: Record<string, string> = {
  1: 'Willkommen im TC Oberthal!', 2: 'Deine Mitgliederinformation', 3: 'Deine Mitgliedschaftsbestätigung', 4: 'Deine Kündigungsbestätigung',
};
const INTRO: Record<string, string> = {
  1: 'klasse, dass du den Weg zu uns in den TC Oberthal gefunden hast!\nIm Namen des gesamten Teams heiße ich dich ganz herzlich willkommen in unserer Vereinsgemeinschaft.\n\n'
    + 'Wir freuen uns sehr, dich bei uns zu haben und wünschen dir viel Spaß auf und neben dem Platz.\nBei uns steht der Spaß am Tennissport, das Miteinander und die Gemeinschaft an erster Stelle.',
  2: 'anbei erhältst du die aktuelle Übersicht zu deiner Mitgliedschaft im TC Oberthal mit deinen hinterlegten Stamm-, Vertrags- und Bankdaten.',
  3: 'anbei erhältst du die Bestätigung deiner Mitgliedschaft im TC Oberthal zur Vorlage bei Arbeitgeber, Krankenkasse oder Verband.',
  4: 'hiermit bestätigen wir dir den Eingang deiner Kündigung und das Ende deiner Mitgliedschaft im TC Oberthal.',
};

/** Mailtext wie MAIL_BUILD_TEXT (Nur-Text, Unterlagen als Freigabelinks) */
export function mailText(v: Verein, art: Art | '', vorname: string, links: { titel: string; link: string }[]) {
  const a = art || '0';
  const teile = [KOPF[a] ?? 'Deine Unterlagen vom TC Oberthal', '', `Hallo ${vorname || 'zusammen'},`, '',
    INTRO[a] ?? 'anbei erhältst du Unterlagen zu deiner Mitgliedschaft im TC Oberthal.'];
  if (a !== '4') {
    teile.push('', 'Damit du keine Neuigkeiten rund um den TC Oberthal verpasst, kannst du gerne unserer Community beitreten:', WA_COMMUNITY, '',
      'Und wenn du über die Jugendarbeit oder Trainingszeiten auf dem Laufenden bleiben möchtest,', 'tritt einfach unserer Jugendgruppe bei:', WA_JUGEND);
  }
  if (links.length) {
    teile.push('', links.length === 1 ? 'Deine Unterlage kannst du hier abrufen:' : 'Deine Unterlagen kannst du hier abrufen:');
    for (const l of links) teile.push(l.titel, l.link);
  }
  const ansprechpartner = (v.mg_ansprechpartner ?? '').split('\n').map((z) => z.trim()).filter(Boolean);
  if (a !== '4' && ansprechpartner.length) {
    teile.push('', 'Bei Fragen rund um Training, Mitgliedschaft oder unseren Verein stehen dir folgende Ansprechpartner gerne zur Verfügung:', ...ansprechpartner);
  }
  teile.push('', a === '1' ? 'Wir freuen uns auf viele gemeinsame Stunden auf dem Platz – willkommen in der TC-Familie!'
    : a === '4' ? 'Wir bedanken uns für deine Mitgliedschaft und viele schöne gemeinsame Zeit auf und abseits des Platzes und wünschen dir für die Zukunft alles Gute!'
      : 'Wir freuen uns auf viele gemeinsame Stunden auf dem Platz!',
  '', 'Sportliche Grüße', v.ansprechpartner || v.name, v.name);
  return { betreff: `${art ? ART_TEXT[art] : 'Mitgliederunterlagen'} ${v.name}`, text: teile.join('\n') };
}
