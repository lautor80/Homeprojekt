/**
 * Dokumenteneingang – Verarbeitung: E-Mail annehmen, Regeln auswerten, in Paperless/Nextcloud ablegen, Prüfliste.
 *
 * n8n liefert jede E-Mail samt Anhängen (POST /eingang/mail). Das Portal legt einen Vorgang an (Schlüssel Postfach +
 * Message-ID, eine E-Mail wird nie doppelt verarbeitet), wertet das Regelwerk aus und legt eindeutige Treffer sofort ab.
 * Alles andere steht mit Inhalt in der Prüfliste, bis jemand entscheidet. Inhalte (Mailtext, Dateien) werden nach dem
 * Abschluss gelöscht; es bleiben Metadaten, die Zuordnung und der Verweis auf das Paperless-Dokument.
 */
import crypto from 'node:crypto';
import { BusinessError } from '../../../../server/src/errors.js';
import { ablegen, anwenden, auswerten, type Regel as PaperlessRegel, type Zuordnung } from '../../../../server/src/lib/paperless-mapping.js';
import { eingangZeit } from '../../../../server/src/lib/maileingang.js';
import { eingerichtet, paperlessZentral, verbindungLesen } from '../../../../server/src/lib/verbindungen.js';
import { WebDav } from '../../../../server/src/lib/webdav.js';
import { htmlToPdf } from '../../../../server/src/pdf.js';
import { heute } from '../format.js';
import { DB } from '../verein.js';
import { V_NEXTCLOUD } from '../verbindung.js';
import {
  absender, dateinameSicher, extrahieren, htmlText, korrespondentFinden, mailHtml, pfadSicher, platzhalter, relevanterAnhang, vorgangStatus, waehlen,
  type Aktionen, type DokStatus, type Kontext, type Korrespondent, type MailAktion, type RegelDef, type VorgangStatus,
} from './logik.js';

export const SYSTEM = 'Dokumenteneingang';

export interface EingangMail {
  postfach: string; ordner: string | null; uid: string | null;
  von: string; an: string; betreff: string; datum: string | null; message_id: string; text: string; html: string;
  anhaenge: { name: string; mime: string | null; inhalt: string; text: string }[];
}

interface DokKontext { k: Kontext; w: Record<string, unknown> }
interface DokZeile {
  id: string; vorgang_id: string; art: 'anhang' | 'mail'; datei: string; mime: string | null; sha256: string | null; inhalt: string | null;
  kontext: DokKontext | null; status: DokStatus;
}
interface Geplant { art: 'anhang' | 'mail'; datei: string; mime: string | null; daten: Buffer; k: Kontext; w: Record<string, unknown>; regel: RegelDef | null }
type GeplanteMailAktion = MailAktion & { aufgaben?: { titel: string; faellig_tage: number | null }[] };

export async function regelnLesen(): Promise<(RegelDef & { beschreibung: string })[]> {
  const rows = await DB`
    select id, name, beschreibung, status, prioritaet, gilt_fuer, verknuepfung, bedingungen, extraktion, aktionen, automatik, version
      from tco.eing_regeln order by prioritaet, id`;
  return rows as unknown as (RegelDef & { beschreibung: string })[];
}

export async function korrespondentenLesen(): Promise<Korrespondent[]> {
  return (await DB`select id, name, kurz, adressen from tco.eing_korrespondenten order by lower(name)`) as unknown as Korrespondent[];
}

async function mitgliedFinden(adresse: string): Promise<{ adrnr: string; vorname: string; nachname: string } | null> {
  if (!adresse) return null;
  const [m] = await DB`
    select adrnr, coalesce(vorname, '') as vorname, coalesce(nachname, '') as nachname
      from tco.mitglieder
     where lower(btrim(email)) = ${adresse} or lower(btrim(emailkih)) = ${adresse}
     order by (austritt is null) desc, (lower(btrim(email)) = ${adresse}) desc, adrnr
     limit 1`;
  return m ? { adrnr: m.adrnr as string, vorname: m.vorname as string, nachname: m.nachname as string } : null;
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const tagBerlin = (d: Date) => d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10);

/** Message-ID ohne spitze Klammern; fehlt sie, ein stabiler Ersatz aus Absender, Betreff und Datum */
export function mailSchluessel(m: Pick<EingangMail, 'message_id' | 'von' | 'betreff' | 'datum'>): string {
  const id = m.message_id.trim().replace(/^<|>$/g, '').toLowerCase();
  return id || `ohne-id-${sha(`${m.von}|${m.betreff}|${m.datum ?? ''}`).slice(0, 32)}`;
}

/** Bedingungsfelder und Platzhalter einer E-Mail (ohne Anhang) */
export async function mailKontext(m: Pick<EingangMail, 'postfach' | 'von' | 'an' | 'betreff' | 'datum' | 'text' | 'html'>, anzahlAnhaenge: number) {
  const ab = absender(m.von);
  const [korr, mg] = await Promise.all([korrespondentenLesen(), mitgliedFinden(ab.adresse)]);
  const k = korrespondentFinden(korr, ab.adresse);
  const tag = tagBerlin(eingangZeit(m.datum));
  const text = (m.text || htmlText(m.html)).slice(0, 100_000);
  const kontext: Kontext = {
    von: ab.adresse, domain: ab.domain, von_name: ab.name, an: m.an, postfach: m.postfach, betreff: m.betreff, text, html: m.html.slice(0, 200_000),
    korrespondent: k?.name ?? '', mitglied: mg ? 'ja' : 'nein', anhaenge: String(anzahlAnhaenge),
  };
  const werte: Record<string, unknown> = {
    betreff: m.betreff, von: ab.adresse, von_name: ab.name || ab.adresse, domain: ab.domain, postfach: m.postfach,
    datum: tag, jahr: tag.slice(0, 4), monat: tag.slice(5, 7), heute: heute(),
    korrespondent: k?.name ?? '', kurz: k?.kurz || k?.name || '',
    mitglied: mg ? `${mg.nachname} ${mg.vorname}`.trim() : '', vorname: mg?.vorname ?? '', nachname: mg?.nachname ?? '', adrnr: mg?.adrnr ?? '',
  };
  return { ab, korrespondent: k, mitglied: mg, text, kontext, werte };
}

const hatAblage = (a: Aktionen) => !!a.paperless?.aktiv || !!a.nextcloud?.aktiv;

/** Ablageziele einer Regel für ein Dokument auflösen (Vorlagen → Werte) */
export function zieleAufloesen(aktionen: Aktionen, werte: Record<string, unknown>, datei: string): { zuordnung: Zuordnung | null; nextcloud: { pfad: string; dateiname: string } | null } {
  const zuordnung = aktionen.paperless?.aktiv ? anwenden(aktionen.paperless as PaperlessRegel, werte) : null;
  let nextcloud: { pfad: string; dateiname: string } | null = null;
  if (aktionen.nextcloud?.aktiv) {
    const endung = /\.[A-Za-z0-9]{1,8}$/.exec(datei)?.[0] ?? '';
    let name = dateinameSicher(auswerten(aktionen.nextcloud.dateiname || '{datei}', werte).text, datei);
    if (endung && !name.toLowerCase().endsWith(endung.toLowerCase())) name += endung;
    nextcloud = { pfad: pfadSicher(auswerten(aktionen.nextcloud.pfad, werte).text), dateiname: name };
  }
  return { zuordnung, nextcloud };
}

interface Ergebnis { status: DokStatus; hinweis: string; paperless_id: number | null; nextcloud_pfad: string | null }

/** Dokument in Paperless und/oder der Nextcloud ablegen; wirft bei Fehlern */
async function ausfuehren(d: DokZeile, ziele: ReturnType<typeof zieleAufloesen>, wer: string): Promise<Ergebnis> {
  if (!d.inhalt) throw new BusinessError('Der Inhalt des Dokuments liegt nicht mehr vor – die E-Mail muss neu eingelesen werden.');
  let daten: Buffer = Buffer.from(d.inhalt, 'base64');
  let datei = d.datei;
  let mime = d.mime ?? undefined;
  // die E-Mail selbst wird als PDF abgelegt (gespeichert ist ein reines Text-HTML)
  if (d.art === 'mail') {
    daten = await htmlToPdf(daten.toString('utf8'));
    datei = datei.replace(/\.html?$/i, '') + (/\.pdf$/i.test(datei) ? '' : '.pdf');
    mime = 'application/pdf';
  }
  const hinweise: string[] = [];
  let paperlessId: number | null = null;
  let dublette = false;
  if (ziele.zuordnung) {
    const [vor] = d.sha256
      ? await DB`select paperless_id from tco.eing_dokumente where sha256 = ${d.sha256} and paperless_id is not null and id <> ${d.id} order by id limit 1`
      : [];
    if (vor) {
      dublette = true;
      paperlessId = vor.paperless_id as number;
      hinweise.push(`Bereits abgelegt (Paperless ${paperlessId}).`);
    } else {
      const pl = await paperlessZentral();
      if (!pl) throw new BusinessError('Paperless ist nicht eingerichtet (Administration → Anbindungen).');
      try {
        const r = await ablegen(pl, ziele.zuordnung, daten, datei, { mime, benutzer: wer });
        paperlessId = r.id;
        hinweise.push(...r.warnungen);
        if (!r.id) hinweise.push('Paperless verarbeitet das Dokument noch.');
      } catch (e) {
        if (!/duplicate|duplikat/i.test((e as Error).message)) throw e;
        dublette = true;
        hinweise.push('Paperless kennt das Dokument bereits (Dublette).');
      }
    }
  }
  let nextcloudPfad: string | null = null;
  if (ziele.nextcloud && !dublette) {
    const v = await verbindungLesen(V_NEXTCLOUD);
    if (!eingerichtet(v) || !v.auth_user || !v.geheimnis) throw new BusinessError('Die Nextcloud ist nicht eingerichtet (Administration → Anbindungen → Nextcloud Dokumentenablage).');
    const dav = new WebDav(v.url, v.auth_user, v.geheimnis, 120_000);
    await dav.ordnerAnlegen(ziele.nextcloud.pfad);
    nextcloudPfad = [ziele.nextcloud.pfad, ziele.nextcloud.dateiname].filter(Boolean).join('/');
    await dav.hochladen(nextcloudPfad, daten);
  }
  return { status: dublette ? 'dublette' : 'abgelegt', hinweis: hinweise.join(' '), paperless_id: paperlessId, nextcloud_pfad: nextcloudPfad };
}

async function dokSetzen(id: string, s: { status: DokStatus; hinweis: string; zuordnung?: unknown; regel?: RegelDef | null; paperless_id?: number | null; nextcloud_pfad?: string | null; wer?: string }) {
  const fertig = ['abgelegt', 'dublette', 'ignoriert'].includes(s.status);
  await DB`
    update tco.eing_dokumente set
           status = ${s.status}, hinweis = ${s.hinweis || null},
           zuordnung = ${s.zuordnung === undefined ? DB`zuordnung` : s.zuordnung === null ? null : DB.json(s.zuordnung as never)},
           regel_id = ${s.regel === undefined ? DB`regel_id` : s.regel?.id ?? null},
           regel_name = ${s.regel === undefined ? DB`regel_name` : s.regel?.name ?? null},
           regel_version = ${s.regel === undefined ? DB`regel_version` : s.regel?.version ?? null},
           paperless_id = ${s.paperless_id ?? null}, nextcloud_pfad = ${s.nextcloud_pfad ?? null},
           inhalt = ${fertig ? null : DB`inhalt`}, kontext = ${fertig ? null : DB`kontext`},
           bearbeitet_am = ${fertig ? DB`now()` : DB`bearbeitet_am`}, bearbeitet_von = ${fertig ? s.wer ?? SYSTEM : DB`bearbeitet_von`}
     where id = ${id}`;
}

/** Regel auf ein Dokument anwenden: sofort ablegen, in die Prüfliste stellen oder ignorieren */
async function entscheiden(d: DokZeile, regel: RegelDef | null, wer: string): Promise<DokStatus> {
  if (!regel) {
    await dokSetzen(d.id, { status: 'pruefen', hinweis: 'Keine Regel passt.', regel: null, zuordnung: null });
    return 'pruefen';
  }
  const { felder, fehlend } = extrahieren(regel.extraktion, d.kontext?.k ?? {});
  const ziele = zieleAufloesen(regel.aktionen, platzhalter(d.kontext?.w ?? {}, felder), d.datei);
  const vorschlag = { ...ziele, felder };
  const pruefen = regel.status === 'testlauf' ? `Testlauf: Regel „${regel.name}“ würde so ablegen.`
    : fehlend.length ? `Regel „${regel.name}“: Pflichtfeld ${fehlend.join(', ')} nicht gefunden.`
      : regel.automatik === 'pruefen' ? `Regel „${regel.name}“ verlangt eine Prüfung.` : '';
  if (pruefen) {
    await dokSetzen(d.id, { status: 'pruefen', hinweis: pruefen, regel, zuordnung: vorschlag });
    return 'pruefen';
  }
  if (!hatAblage(regel.aktionen)) {
    await dokSetzen(d.id, { status: 'ignoriert', hinweis: `Regel „${regel.name}“: keine Ablage vorgesehen.`, regel, zuordnung: null, wer });
    return 'ignoriert';
  }
  try {
    const r = await ausfuehren(d, ziele, wer);
    await dokSetzen(d.id, { ...r, regel, zuordnung: vorschlag, wer });
    return r.status;
  } catch (e) {
    await dokSetzen(d.id, { status: 'fehler', hinweis: (e as Error).message.slice(0, 1000), regel, zuordnung: vorschlag });
    return 'fehler';
  }
}

/** Status des Vorgangs aus den Dokumenten neu bestimmen; nach dem Abschluss den Mailtext löschen */
export async function abschliessen(vorgangId: string | number): Promise<VorgangStatus> {
  const docs = await DB`select status from tco.eing_dokumente where vorgang_id = ${vorgangId}`;
  const [v] = await DB`select status, mail_aktion from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  // von Hand ignorierte Vorgänge ohne Dokumente bleiben ignoriert
  const status = !docs.length && v.status === 'ignoriert' ? 'ignoriert' : vorgangStatus(docs.map((d) => d.status as DokStatus), v.mail_aktion != null);
  const fertig = status === 'abgelegt' || status === 'ignoriert';
  await DB`
    update tco.eing_vorgaenge set status = ${status},
           text = ${fertig || status === 'ohne_regel' ? null : DB`text`},
           abgeschlossen_am = ${fertig ? DB`coalesce(abgeschlossen_am, now())` : null}
     where id = ${vorgangId}`;
  return status;
}

const mailAktionVon = (r: RegelDef): GeplanteMailAktion => ({
  art: r.aktionen.mail?.art ?? 'keine', ordner: r.aktionen.mail?.ordner ?? '', gelesen: !!r.aktionen.mail?.gelesen,
  aufgaben: r.aktionen.aufgabe?.aktiv && r.aktionen.aufgabe.titel.trim() ? [{ titel: r.aktionen.aufgabe.titel, faellig_tage: r.aktionen.aufgabe.faellig_tage ?? null }] : [],
});
const scharf = (r: RegelDef | null | undefined): r is RegelDef => !!r && r.status === 'aktiv';

/** Antwort an n8n bzw. Stand eines Vorgangs: Dokumente und – sobald alles abgelegt ist – die Behandlung der E-Mail */
export async function vorgangAntwort(vorgangId: string | number, neu: boolean) {
  const [v] = await DB`select id, status, hinweis, ordner, uid, mail_aktion, mail_erledigt_am from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const docs = await DB`select id, art, datei, status, regel_name, paperless_id, nextcloud_pfad, hinweis from tco.eing_dokumente where vorgang_id = ${vorgangId} order by id`;
  const a = v.mail_aktion as GeplanteMailAktion | null;
  const fertig = v.status === 'abgelegt' && !!a;
  return {
    vorgang: Number(v.id), neu, status: v.status as VorgangStatus, hinweis: (v.hinweis as string | null) ?? '',
    dokumente: docs.map((d) => ({ id: Number(d.id), art: d.art as string, datei: d.datei as string, status: d.status as DokStatus, regel: (d.regel_name as string | null) ?? '',
      paperless_id: d.paperless_id as number | null, nextcloud_pfad: d.nextcloud_pfad as string | null, hinweis: (d.hinweis as string | null) ?? '' })),
    mail: fertig && !v.mail_erledigt_am && (a.art !== 'keine' || a.gelesen)
      ? { art: a.art, ordner: a.ordner ?? '', gelesen: !!a.gelesen, quelle: (v.ordner as string | null) ?? '', uid: (v.uid as string | null) ?? '' } : null,
    aufgaben: fertig && !v.mail_erledigt_am ? a.aufgaben ?? [] : [],
  };
}

/** Eingegangene E-Mail verarbeiten (idempotent je Postfach + Message-ID) */
export async function mailVerarbeiten(m: EingangMail) {
  const schluessel = mailSchluessel(m);
  const [alt] = await DB`select id from tco.eing_vorgaenge where postfach = ${m.postfach} and message_id = ${schluessel}`;
  if (alt) return vorgangAntwort(alt.id as string, false);

  const anhaenge = m.anhaenge
    .map((a) => { const daten = Buffer.from(a.inhalt.replace(/^data:[^,]*,/, ''), 'base64'); return { name: dateinameSicher(a.name, 'anhang'), mime: a.mime, daten, groesse: daten.length, text: a.text }; })
    .filter(relevanterAnhang);
  const { ab, korrespondent, mitglied, text, kontext, werte } = await mailKontext(m, anhaenge.length);
  const regeln = await regelnLesen();

  const mailRegel = waehlen(regeln, kontext, 'mail');
  const geplant: Geplant[] = anhaenge.map((a) => {
    const k: Kontext = { ...kontext, datei: a.name, mime: a.mime ?? '', doktext: a.text.slice(0, 200_000) };
    return { art: 'anhang', datei: a.name, mime: a.mime, daten: a.daten, k, w: { ...werte, datei: a.name }, regel: waehlen(regeln, k, 'anhang') };
  });
  // die E-Mail selbst wird nur dann ein Dokument, wenn eine Mail-Regel sie ablegen will
  if (mailRegel && hatAblage(mailRegel.aktionen)) {
    const datei = `${dateinameSicher(m.betreff, 'E-Mail')}.pdf`;
    const html = mailHtml({ von: m.von, an: m.an, betreff: m.betreff, datum: String(werte.datum), text });
    geplant.push({ art: 'mail', datei, mime: 'text/html', daten: Buffer.from(html, 'utf8'), k: { ...kontext, datei, mime: 'application/pdf' }, w: { ...werte, datei }, regel: mailRegel });
  }

  // Behandlung der E-Mail: die Mail-Regel bestimmt; sonst die ranghöchste aktive Anhang-Regel
  const fuehrend = scharf(mailRegel) ? mailRegel
    : geplant.map((g) => g.regel).filter(scharf).sort((x, y) => x.prioritaet - y.prioritaet || x.id - y.id)[0] ?? null;
  const hinweis = mailRegel?.status === 'testlauf' ? `Testlauf: Regel „${mailRegel.name}“ würde diese E-Mail behandeln.` : !mailRegel && !geplant.length ? 'Keine Regel passt.' : null;
  // der Mailtext bleibt nur, solange Dokumente offen sein können (abschliessen() löscht ihn)
  const behalten = geplant.length > 0;

  const [v] = await DB`
    insert into tco.eing_vorgaenge (postfach, message_id, ordner, uid, von, von_name, an, betreff, datum, status, hinweis, mitglied_adrnr, korrespondent, text, mail_aktion)
    values (${m.postfach}, ${schluessel}, ${m.ordner}, ${m.uid}, ${ab.adresse || m.von.slice(0, 500)}, ${ab.name || null}, ${m.an.slice(0, 1000)}, ${m.betreff.slice(0, 1000)},
            ${eingangZeit(m.datum)}, 'neu', ${hinweis}, ${mitglied?.adrnr ?? null}, ${korrespondent?.name ?? null}, ${behalten ? text.slice(0, 20_000) : null},
            ${fuehrend ? DB.json(mailAktionVon(fuehrend) as never) : null})
    on conflict (postfach, message_id) do nothing
    returning id`;
  if (!v) {
    const [da] = await DB`select id from tco.eing_vorgaenge where postfach = ${m.postfach} and message_id = ${schluessel}`;
    return vorgangAntwort(da.id as string, false);
  }

  for (const g of geplant) {
    const inhalt = g.daten.toString('base64');
    const k: DokKontext = { k: g.k, w: g.w };
    const [d] = await DB`
      insert into tco.eing_dokumente (vorgang_id, art, datei, mime, groesse, sha256, inhalt, kontext, status)
      values (${v.id}, ${g.art}, ${g.datei}, ${g.mime}, ${g.daten.length}, ${sha(g.daten)}, ${inhalt}, ${DB.json(k as never)}, 'neu')
      returning id`;
    await entscheiden({ id: d.id as string, vorgang_id: v.id as string, art: g.art, datei: g.datei, mime: g.mime, sha256: sha(g.daten), inhalt, kontext: k, status: 'neu' }, g.regel, SYSTEM);
  }
  await abschliessen(v.id as string);
  return vorgangAntwort(v.id as string, true);
}

async function dokLesen(id: number): Promise<DokZeile> {
  const [d] = await DB`select id, vorgang_id, art, datei, mime, sha256, inhalt, kontext, status from tco.eing_dokumente where id = ${id}`;
  if (!d) throw new BusinessError('Das Dokument gibt es nicht (mehr).', 404);
  return d as unknown as DokZeile;
}
const offen = (d: DokZeile) => {
  if (!['pruefen', 'fehler', 'neu'].includes(d.status)) throw new BusinessError('Das Dokument ist bereits erledigt.');
};

export interface AblageEingabe {
  regel_id?: number | null;
  /** von Hand gewählte Ablage in Paperless (Vorlagen erlaubt); überlagert die Regel feldweise */
  paperless?: PaperlessRegel | null;
  nextcloud?: { pfad: string; dateiname: string } | null;
  mail?: MailAktion | null;
}

/** Prüfliste: Dokument mit einer Regel oder von Hand ablegen */
export async function dokumentAblegen(id: number, e: AblageEingabe, wer: string) {
  const d = await dokLesen(id);
  offen(d);
  const regel = e.regel_id ? (await regelnLesen()).find((r) => r.id === e.regel_id) ?? null : null;
  if (e.regel_id && !regel) throw new BusinessError('Die gewählte Regel gibt es nicht (mehr).');
  const felder = regel ? extrahieren(regel.extraktion, d.kontext?.k ?? {}).felder : {};
  const werte = platzhalter(d.kontext?.w ?? {}, felder);
  const aktionen: Aktionen = {
    paperless: e.paperless ? { ...(regel?.aktionen.paperless ?? {}), ...e.paperless, aktiv: true } : regel?.aktionen.paperless,
    nextcloud: e.nextcloud ? { aktiv: true, ...e.nextcloud } : e.nextcloud === null ? undefined : regel?.aktionen.nextcloud,
  };
  if (!hatAblage(aktionen)) throw new BusinessError('Bitte eine Regel mit Ablage wählen oder die Ablage in Paperless angeben.');
  const ziele = zieleAufloesen(aktionen, werte, d.datei);
  let r: Ergebnis;
  try {
    r = await ausfuehren(d, ziele, wer);
  } catch (err) {
    await dokSetzen(d.id, { status: 'fehler', hinweis: (err as Error).message.slice(0, 1000), regel, zuordnung: { ...ziele, felder } });
    await abschliessen(d.vorgang_id);
    throw new BusinessError(`Ablage fehlgeschlagen: ${(err as Error).message}`);
  }
  await dokSetzen(d.id, { ...r, regel, zuordnung: { ...ziele, felder }, wer });
  // Behandlung der E-Mail: ausdrücklich gewählt, sonst aus der Regel, sonst unverändert
  const aktion: GeplanteMailAktion | null = e.mail ? { ...e.mail, aufgaben: [] } : regel ? mailAktionVon(regel) : null;
  if (aktion) {
    await DB`update tco.eing_vorgaenge set mail_aktion = ${DB.json(aktion as never)}
              where id = ${d.vorgang_id} and (mail_aktion is null or ${!!e.mail})`;
  }
  const status = await abschliessen(d.vorgang_id);
  return { status, text: `${d.datei}: ${r.status === 'dublette' ? 'bereits vorhanden' : 'abgelegt'}${r.paperless_id ? ` (Paperless ${r.paperless_id})` : ''}${r.hinweis ? ` – ${r.hinweis}` : ''}` };
}

export async function dokumentIgnorieren(id: number, wer: string) {
  const d = await dokLesen(id);
  offen(d);
  await dokSetzen(d.id, { status: 'ignoriert', hinweis: 'Von Hand ignoriert.', wer });
  return { status: await abschliessen(d.vorgang_id), text: `${d.datei} wird nicht abgelegt.` };
}

/** Prüfliste: Regelwerk erneut auf die offenen Dokumente eines Vorgangs anwenden (z. B. nach einer neuen Regel) */
export async function neuBewerten(vorgangId: number, wer: string) {
  const regeln = await regelnLesen();
  const docs = (await DB`
    select id, vorgang_id, art, datei, mime, sha256, inhalt, kontext, status
      from tco.eing_dokumente where vorgang_id = ${vorgangId} and status in ('pruefen', 'fehler', 'neu') order by id`) as unknown as DokZeile[];
  const [v] = await DB`select mail_aktion from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const treffer: RegelDef[] = [];
  for (const d of docs) {
    const regel = waehlen(regeln, d.kontext?.k ?? {}, d.art);
    if (scharf(regel)) treffer.push(regel);
    await entscheiden(d, regel, wer);
  }
  const fuehrend = treffer.sort((x, y) => x.prioritaet - y.prioritaet || x.id - y.id)[0];
  if (fuehrend && v.mail_aktion == null) await DB`update tco.eing_vorgaenge set mail_aktion = ${DB.json(mailAktionVon(fuehrend) as never)} where id = ${vorgangId}`;
  const status = await abschliessen(vorgangId);
  return { status, text: `${docs.length} Dokument${docs.length === 1 ? '' : 'e'} neu bewertet.` };
}

/** Vorgang ohne Ablage schließen (offene Dokumente werden ignoriert, die E-Mail bleibt unangetastet) */
export async function vorgangIgnorieren(vorgangId: number, wer: string) {
  const [v] = await DB`select id from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  await DB`update tco.eing_vorgaenge set mail_aktion = null where id = ${vorgangId}`;
  await DB`
    update tco.eing_dokumente set status = 'ignoriert', hinweis = 'Von Hand ignoriert.', inhalt = null, kontext = null, bearbeitet_am = now(), bearbeitet_von = ${wer}
     where vorgang_id = ${vorgangId} and status in ('pruefen', 'fehler', 'neu')`;
  await DB`update tco.eing_vorgaenge set status = 'ignoriert', text = null, abgeschlossen_am = coalesce(abgeschlossen_am, now()) where id = ${vorgangId} and status in ('ohne_regel', 'neu')`;
  return { status: await abschliessen(vorgangId), text: 'Vorgang geschlossen.' };
}

/**
 * Abgleich für n8n: welche E-Mails des Postfachs sind neu (müssen geliefert werden), und für welche bekannten steht die
 * Behandlung (verschieben, gelesen, löschen) noch aus – z. B. nach der Freigabe in der Prüfliste.
 */
export async function abgleich(postfach: string, mails: { message_id: string; uid?: string | null }[]) {
  const mitSchluessel = mails.map((x) => ({ ...x, schluessel: x.message_id.trim().replace(/^<|>$/g, '').toLowerCase() })).filter((x) => x.schluessel);
  const bekannt = mitSchluessel.length ? await DB`
    select id, message_id, status, ordner, mail_aktion, mail_erledigt_am
      from tco.eing_vorgaenge where postfach = ${postfach} and message_id = any(${mitSchluessel.map((x) => x.schluessel)}::text[])` : [];
  const index = new Map(bekannt.map((b) => [b.message_id as string, b]));
  const neu = mitSchluessel.filter((x) => !index.has(x.schluessel)).map((x) => ({ message_id: x.message_id, uid: x.uid ?? '' }));
  const aktionen = mitSchluessel.flatMap((x) => {
    const b = index.get(x.schluessel);
    const a = b?.mail_aktion as GeplanteMailAktion | null | undefined;
    if (!b || !a || b.status !== 'abgelegt' || b.mail_erledigt_am || (a.art === 'keine' && !a.gelesen)) return [];
    return [{ vorgang: Number(b.id), message_id: x.message_id, uid: x.uid ?? '', quelle: (b.ordner as string | null) ?? '', art: a.art, ordner: a.ordner ?? '', gelesen: !!a.gelesen, aufgaben: a.aufgaben ?? [] }];
  });
  return { neu, aktionen };
}

/** Für n8n: alle E-Mails, deren Behandlung noch aussteht (ohne Liste der Message-IDs – z. B. für einen eigenen Zeitplan) */
export async function ausstehendeAktionen(postfach: string | null) {
  const rows = await DB`
    select id, postfach, message_id, ordner, uid, mail_aktion
      from tco.eing_vorgaenge
     where status = 'abgelegt' and mail_aktion is not null and mail_erledigt_am is null
           ${postfach ? DB`and postfach = ${postfach}` : DB``}
     order by id limit 200`;
  return rows.flatMap((b) => {
    const a = b.mail_aktion as GeplanteMailAktion;
    if (a.art === 'keine' && !a.gelesen) return [];
    return [{ vorgang: Number(b.id), postfach: b.postfach as string, message_id: b.message_id as string, uid: (b.uid as string | null) ?? '', quelle: (b.ordner as string | null) ?? '',
      art: a.art, ordner: a.ordner ?? '', gelesen: !!a.gelesen, aufgaben: a.aufgaben ?? [] }];
  });
}
