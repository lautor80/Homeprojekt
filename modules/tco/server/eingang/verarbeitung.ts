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
import { eingangVerbuchen } from '../../../../server/src/lib/maileingang-db.js';
import { eingerichtet, paperlessZentral, verbindungLesen } from '../../../../server/src/lib/verbindungen.js';
import { WebDav } from '../../../../server/src/lib/webdav.js';
import { BILD_MIME, htmlToPdf, istPdf, pdfsZusammenfuegen } from '../../../../server/src/pdf.js';
import { heute } from '../format.js';
import { DB } from '../verein.js';
import { V_NEXTCLOUD } from '../verbindung.js';
import {
  absender, dateinameSicher, extrahieren, htmlText, korrespondentFinden, mailHtml, pfadSicher, platzhalter, regelPasst, relevanterAnhang, vorgangStatus, waehlen,
  type Aktionen, type DokStatus, type Kontext, type Korrespondent, type MailAktion, type RegelDef, type VorgangStatus,
} from './logik.js';

export const SYSTEM = 'Dokumenteneingang';

export interface EingangMail {
  postfach: string; ordner: string | null; uid: string | null;
  von: string; an: string; betreff: string; datum: string | null; message_id: string; text: string; html: string;
  /** Kopfzeilen für die Rückmeldungen im E-Mail-Protokoll */
  in_reply_to: string | null; references: string | null; auto: string | null;
  anhaenge: { name: string; mime: string | null; inhalt: string; text: string }[];
}

interface DokKontext { k: Kontext; w: Record<string, unknown> }
interface DokZeile {
  id: string; vorgang_id: string; art: 'anhang' | 'mail'; datei: string; mime: string | null; sha256: string | null; inhalt: string | null;
  kontext: DokKontext | null; status: DokStatus;
}
interface Geplant {
  art: 'anhang' | 'mail'; datei: string; mime: string | null; daten: Buffer; k: Kontext; w: Record<string, unknown>; regel: RegelDef | null;
  /** zusammengefasstes Dokument: Schlüssel für die Dublettenprüfung aus den Teilen, Hinweis auf die Teile */
  sha256?: string; zusatz?: string; teile?: Geplant[];
  /** Zusammenfassen fehlgeschlagen: nicht automatisch ablegen, sondern prüfen */
  pruefen?: string;
}

/**
 * Anhänge je Regel mit „zusammenfassen“ zu einem PDF zusammenfügen (nur PDFs und Bilder, ab zwei Teilen). Schlägt das
 * Zusammenfügen fehl, gehen die Teile einzeln mit Hinweis in die Prüfliste.
 */
async function zusammenfassen(geplant: Geplant[]): Promise<Geplant[]> {
  const gruppen = new Map<number, Geplant[]>();
  for (const g of geplant) {
    if (g.art !== 'anhang' || !g.regel?.aktionen.zusammenfassen?.aktiv) continue;
    if (!istPdf(g.mime, g.datei) && !BILD_MIME.test(g.mime ?? '')) continue;
    gruppen.set(g.regel.id, [...(gruppen.get(g.regel.id) ?? []), g]);
  }
  const ersetzt = new Map<Geplant, Geplant | null>();
  for (const teile of gruppen.values()) {
    if (teile.length < 2) continue;
    const regel = teile[0].regel!;
    const z = regel.aktionen.zusammenfassen!;
    const sortiert = z.reihenfolge === 'name' ? [...teile].sort((a, b) => a.datei.localeCompare(b.datei, 'de', { numeric: true })) : teile;
    const werte = { ...sortiert[0].w, anzahl: sortiert.length };
    let datei = dateinameSicher(auswerten(z.dateiname || '{datei|ohneEndung}', werte).text, 'Sammeldokument');
    if (!/\.pdf$/i.test(datei)) datei += '.pdf';
    const namen = sortiert.map((t) => t.datei).join(', ');
    try {
      const daten = await pdfsZusammenfuegen(sortiert.map((t) => ({ name: t.datei, mime: t.mime, daten: t.daten })));
      const doktext = sortiert.map((t) => t.k.doktext ?? '').filter(Boolean).join('\n\n').slice(0, 200_000);
      ersetzt.set(sortiert[0], {
        art: 'anhang', datei, mime: 'application/pdf', daten, regel,
        k: { ...sortiert[0].k, datei, mime: 'application/pdf', doktext }, w: { ...werte, datei },
        sha256: sha(sortiert.map((t) => sha(t.daten)).join('|')), zusatz: `Zusammengefasst aus ${sortiert.length} Anhängen: ${namen}.`, teile: sortiert,
      });
      for (const t of sortiert.slice(1)) ersetzt.set(t, null);
    } catch (e) {
      for (const t of sortiert) t.pruefen = `Zusammenfassen fehlgeschlagen (${(e as Error).message}) – bitte prüfen; „Ablegen“ legt einzeln ab.`;
    }
  }
  return geplant.flatMap((g) => (ersetzt.has(g) ? (ersetzt.get(g) ? [ersetzt.get(g)!] : []) : [g]));
}
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
async function entscheiden(d: DokZeile, regel: RegelDef | null, wer: string, zwang?: string): Promise<DokStatus> {
  if (!regel) {
    await dokSetzen(d.id, { status: 'pruefen', hinweis: 'Keine Regel passt.', regel: null, zuordnung: null });
    return 'pruefen';
  }
  const { felder, fehlend } = extrahieren(regel.extraktion, d.kontext?.k ?? {});
  const ziele = zieleAufloesen(regel.aktionen, platzhalter(d.kontext?.w ?? {}, felder), d.datei);
  const vorschlag = { ...ziele, felder };
  const pruefen = zwang ? zwang : regel.status === 'testlauf' ? `Testlauf: Regel „${regel.name}“ würde so ablegen.`
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

/**
 * Eingegangene E-Mail verarbeiten (idempotent je Postfach + Message-ID).
 * Ausnahme: Eine E-Mail, die als „ohne Regel“ protokolliert ist (ohne Inhalt gespeichert), wird bei erneuter Lieferung neu
 * bewertet – z. B. nach „Posteingang abrufen“ im Portal, wenn inzwischen eine Regel passt. Passt weiterhin keine, bleibt der
 * bisherige Vorgang unverändert.
 */
export async function mailVerarbeiten(m: EingangMail) {
  const schluessel = mailSchluessel(m);
  const [alt] = await DB`select id, status from tco.eing_vorgaenge where postfach = ${m.postfach} and message_id = ${schluessel}`;
  const nachbewerten: string | null = alt?.status === 'ohne_regel' ? (alt.id as string) : null;
  if (alt && !nachbewerten) return vorgangAntwort(alt.id as string, false);
  // den bisherigen Vorgang „ohne Regel“ ersetzen (er hat keine Dokumente und keinen Inhalt)
  const altEntfernen = async () => {
    if (nachbewerten) await DB`delete from tco.eing_vorgaenge where id = ${nachbewerten} and status = 'ohne_regel'`;
  };

  const anhaenge = m.anhaenge
    .map((a) => { const daten = Buffer.from(a.inhalt.replace(/^data:[^,]*,/, ''), 'base64'); return { name: dateinameSicher(a.name, 'anhang'), mime: a.mime, daten, groesse: daten.length, text: a.text }; })
    .filter(relevanterAnhang);
  const { ab, korrespondent, mitglied, text, kontext, werte } = await mailKontext(m, anhaenge.length);

  // Rückmeldung zu einer gesendeten E-Mail (unzustellbar, Abwesenheit, Antwort) im E-Mail-Protokoll verbuchen –
  // ersetzt den eigenen Aufruf von POST /api/mail/eingang. Rückläufer und Abwesenheitsnotizen werden nicht abgelegt.
  const rueck = await eingangVerbuchen(DB, {
    postfach: m.an, von: m.von, betreff: m.betreff, datum: m.datum, message_id: m.message_id,
    in_reply_to: m.in_reply_to, references: m.references, auto: m.auto, text,
  });
  if (rueck.art !== 'antwort' && (rueck.zugeordnet || !anhaenge.length)) {
    const hinweis = `${rueck.art === 'unzustellbar' ? 'Unzustellbar-Meldung' : 'Abwesenheitsnotiz'}${rueck.zugeordnet ? ' – im E-Mail-Protokoll verbucht' : ''}; nicht abgelegt.`;
    await altEntfernen();
    const [r] = await DB`
      insert into tco.eing_vorgaenge (postfach, message_id, ordner, uid, von, von_name, an, betreff, datum, status, hinweis, abgeschlossen_am)
      values (${m.postfach}, ${schluessel}, ${m.ordner}, ${m.uid}, ${ab.adresse || m.von.slice(0, 500)}, ${ab.name || null}, ${m.an.slice(0, 1000)}, ${m.betreff.slice(0, 1000)},
              ${eingangZeit(m.datum)}, 'ignoriert', ${hinweis}, now())
      on conflict (postfach, message_id) do nothing
      returning id`;
    const [da] = r ? [r] : await DB`select id from tco.eing_vorgaenge where postfach = ${m.postfach} and message_id = ${schluessel}`;
    return { ...(await vorgangAntwort(da.id as string, !!r)), rueckmeldung: rueck };
  }
  const regeln = await regelnLesen();

  const mailRegel = waehlen(regeln, kontext, 'mail');
  const geplant: Geplant[] = await zusammenfassen(anhaenge.map((a) => {
    const k: Kontext = { ...kontext, datei: a.name, mime: a.mime ?? '', doktext: a.text.slice(0, 200_000) };
    return { art: 'anhang', datei: a.name, mime: a.mime, daten: a.daten, k, w: { ...werte, datei: a.name }, regel: waehlen(regeln, k, 'anhang') };
  }));
  // die E-Mail selbst wird nur dann ein Dokument, wenn eine Mail-Regel sie ablegen will
  if (mailRegel && hatAblage(mailRegel.aktionen)) {
    const datei = `${dateinameSicher(m.betreff, 'E-Mail')}.pdf`;
    const html = mailHtml({ von: m.von, an: m.an, betreff: m.betreff, datum: String(werte.datum), text });
    geplant.push({ art: 'mail', datei, mime: 'text/html', daten: Buffer.from(html, 'utf8'), k: { ...kontext, datei, mime: 'application/pdf' }, w: { ...werte, datei }, regel: mailRegel });
  }

  // erneut geliefert und weiterhin ohne passende Regel: bisherigen Vorgang behalten
  if (nachbewerten && !mailRegel && !geplant.length) return { ...(await vorgangAntwort(nachbewerten, false)), rueckmeldung: rueck };
  await altEntfernen();

  // Behandlung der E-Mail: die Mail-Regel bestimmt; sonst die ranghöchste aktive Anhang-Regel
  const fuehrend = scharf(mailRegel) ? mailRegel
    : geplant.map((g) => g.regel).filter(scharf).sort((x, y) => x.prioritaet - y.prioritaet || x.id - y.id)[0] ?? null;
  const hinweis = [rueck.zugeordnet ? 'Antwort auf eine E-Mail des Portals (im E-Mail-Protokoll verbucht).' : '',
    mailRegel?.status === 'testlauf' ? `Testlauf: Regel „${mailRegel.name}“ würde diese E-Mail behandeln.` : !mailRegel && !geplant.length ? 'Keine Regel passt.' : '']
    .filter(Boolean).join(' ') || null;
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
    return { ...(await vorgangAntwort(da.id as string, false)), rueckmeldung: rueck };
  }

  for (const g of geplant) {
    const inhalt = g.daten.toString('base64');
    const k: DokKontext = { k: g.k, w: g.w };
    const hash = g.sha256 ?? sha(g.daten);
    const [d] = await DB`
      insert into tco.eing_dokumente (vorgang_id, art, datei, mime, groesse, sha256, inhalt, kontext, status)
      values (${v.id}, ${g.art}, ${g.datei}, ${g.mime}, ${g.daten.length}, ${hash}, ${inhalt}, ${DB.json(k as never)}, 'neu')
      returning id`;
    await entscheiden({ id: d.id as string, vorgang_id: v.id as string, art: g.art, datei: g.datei, mime: g.mime, sha256: hash, inhalt, kontext: k, status: 'neu' }, g.regel, SYSTEM, g.pruefen);
    if (g.zusatz) await DB`update tco.eing_dokumente set hinweis = ${g.zusatz} || coalesce(' ' || hinweis, '') where id = ${d.id}`;
  }
  await abschliessen(v.id as string);
  return { ...(await vorgangAntwort(v.id as string, true)), rueckmeldung: rueck };
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
  return { status, anzahl: docs.length, text: `${docs.length} Dokument${docs.length === 1 ? '' : 'e'} neu bewertet.` };
}

/** Prüfliste: Regelwerk erneut auf alle offenen Vorgänge anwenden (Teil von „Posteingang abrufen“) */
export async function offeneNeuBewerten(wer: string) {
  const offen = await DB`
    select distinct vorgang_id from tco.eing_dokumente where status in ('pruefen', 'fehler', 'neu') order by vorgang_id limit 500`;
  let dokumente = 0;
  for (const o of offen) {
    dokumente += (await neuBewerten(Number(o.vorgang_id), wer)).anzahl;
  }
  return { vorgaenge: offen.length, dokumente };
}

/** Kontext eines Vorgangs für die Regelauswahl: offene Dokumente mit ihrem gespeicherten Kontext, die E-Mail aus den Metadaten */
async function vorgangKontext(vorgangId: number) {
  const [v] = await DB`select id, postfach, von, von_name, an, betreff, datum, text, mail_aktion from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  const docs = (await DB`
    select id, vorgang_id, art, datei, mime, sha256, inhalt, kontext, status
      from tco.eing_dokumente where vorgang_id = ${vorgangId} and status in ('pruefen', 'fehler', 'neu') order by id`) as unknown as DokZeile[];
  const von = v.von_name ? `${v.von_name as string} <${(v.von as string | null) ?? ''}>` : ((v.von as string | null) ?? '');
  const m = { postfach: v.postfach as string, von, an: (v.an as string | null) ?? '', betreff: (v.betreff as string | null) ?? '',
    datum: v.datum ? new Date(v.datum as string).toISOString() : null, text: (v.text as string | null) ?? '', html: '' };
  const mk = await mailKontext(m, docs.filter((d) => d.art === 'anhang').length);
  return { v, docs, m, mk };
}

/** Prüfliste „Regel zuordnen“: alle Regeln mit der Angabe, ob ihre Bedingungen auf den Vorgang passen */
export async function regelnFuerVorgang(vorgangId: number) {
  const { docs, mk } = await vorgangKontext(vorgangId);
  const anhaenge = docs.filter((d) => d.art === 'anhang' && d.kontext);
  return (await regelnLesen()).map((r) => ({
    id: r.id, name: r.name, status: r.status, gilt_fuer: r.gilt_fuer,
    passt: r.gilt_fuer === 'mail' ? regelPasst(r, mk.kontext) : anhaenge.some((d) => regelPasst(r, d.kontext!.k)),
    anwendbar: r.status !== 'aus' && (r.gilt_fuer === 'mail' || anhaenge.length > 0),
  }));
}

/**
 * Prüfliste: eine bestehende Regel von Hand zuordnen und anwenden – unabhängig davon, ob ihre Bedingungen passen.
 * Regeln je Anhang wirken auf alle offenen Anhänge (mit Zusammenfassen, falls die Regel es vorsieht), Regeln für die
 * E-Mail legen die E-Mail als PDF ab (nur solange der Mailtext vorliegt) bzw. setzen ihre Behandlung. Testlauf-Regeln
 * erzeugen wie beim Eingang nur einen Vorschlag.
 */
export async function regelZuordnen(vorgangId: number, regelId: number, wer: string) {
  const regel = (await regelnLesen()).find((r) => r.id === regelId);
  if (!regel) throw new BusinessError('Die gewählte Regel gibt es nicht (mehr).', 404);
  if (regel.status === 'aus') throw new BusinessError(`Die Regel „${regel.name}“ ist ausgeschaltet.`);
  const { docs, m, mk } = await vorgangKontext(vorgangId);
  let anzahl = 0;
  if (regel.gilt_fuer === 'anhang') {
    const anhaenge = docs.filter((d) => d.art === 'anhang');
    if (!anhaenge.length) throw new BusinessError('Der Vorgang hat keine offenen Anhänge – die Regel gilt je Anhang.');
    const geplant = await zusammenfassen(anhaenge.map((d): Geplant & { quelle: DokZeile } => ({
      quelle: d, art: 'anhang', datei: d.datei, mime: d.mime, daten: Buffer.from(d.inhalt ?? '', 'base64'), k: d.kontext?.k ?? {}, w: d.kontext?.w ?? {}, regel,
    })));
    for (const g of geplant as (Geplant & { quelle?: DokZeile })[]) {
      if (!g.zusatz) { await entscheiden(g.quelle!, regel, wer, g.pruefen); anzahl++; continue; }
      // zusammengefasst: neues Dokument, die Teile gelten als erledigt
      const inhalt = g.daten.toString('base64');
      const k: DokKontext = { k: g.k, w: g.w };
      const [d] = await DB`
        insert into tco.eing_dokumente (vorgang_id, art, datei, mime, groesse, sha256, inhalt, kontext, status)
        values (${vorgangId}, 'anhang', ${g.datei}, ${g.mime}, ${g.daten.length}, ${g.sha256!}, ${inhalt}, ${DB.json(k as never)}, 'neu') returning id`;
      for (const t of (g.teile ?? []) as (Geplant & { quelle: DokZeile })[]) {
        await dokSetzen(t.quelle.id, { status: 'ignoriert', hinweis: `In „${g.datei}“ zusammengefasst.`, regel, wer });
      }
      await entscheiden({ id: d.id as string, vorgang_id: String(vorgangId), art: 'anhang', datei: g.datei, mime: g.mime, sha256: g.sha256!, inhalt, kontext: k, status: 'neu' }, regel, wer);
      await DB`update tco.eing_dokumente set hinweis = ${g.zusatz} || coalesce(' ' || hinweis, '') where id = ${d.id}`;
      anzahl++;
    }
  } else if (hatAblage(regel.aktionen)) {
    if (!m.text) throw new BusinessError('Der Mailtext liegt nicht mehr vor – die E-Mail kann nicht als PDF abgelegt werden. Bitte die Regel speichern und „Posteingang abrufen“.');
    const datei = `${dateinameSicher(m.betreff, 'E-Mail')}.pdf`;
    const html = mailHtml({ von: m.von, an: m.an, betreff: m.betreff, datum: String(mk.werte.datum), text: m.text });
    const daten = Buffer.from(html, 'utf8');
    const k: DokKontext = { k: { ...mk.kontext, datei, mime: 'application/pdf' }, w: { ...mk.werte, datei } };
    const [d] = await DB`
      insert into tco.eing_dokumente (vorgang_id, art, datei, mime, groesse, sha256, inhalt, kontext, status)
      values (${vorgangId}, 'mail', ${datei}, 'text/html', ${daten.length}, ${sha(daten)}, ${daten.toString('base64')}, ${DB.json(k as never)}, 'neu') returning id`;
    await entscheiden({ id: d.id as string, vorgang_id: String(vorgangId), art: 'mail', datei, mime: 'text/html', sha256: sha(daten), inhalt: daten.toString('base64'), kontext: k, status: 'neu' }, regel, wer);
    anzahl++;
  }
  // Behandlung der E-Mail aus der zugeordneten Regel (nur aktive Regeln; im Testlauf bleibt die E-Mail unangetastet)
  const hinweis = regel.status === 'testlauf' ? `Testlauf: Regel „${regel.name}“ von Hand zugeordnet (${wer}).` : `Regel „${regel.name}“ von Hand zugeordnet (${wer}).`;
  await DB`
    update tco.eing_vorgaenge set hinweis = ${hinweis},
           mail_aktion = ${scharf(regel) ? DB.json(mailAktionVon(regel) as never) : DB`mail_aktion`}
     where id = ${vorgangId}`;
  const status = await abschliessen(vorgangId);
  const was = regel.gilt_fuer === 'anhang' ? `${anzahl} Dokument${anzahl === 1 ? '' : 'e'}` : anzahl ? 'E-Mail als PDF' : 'Behandlung der E-Mail';
  return { status, text: `Regel „${regel.name}“ zugeordnet: ${was} ${regel.status === 'testlauf' ? 'als Vorschlag (Testlauf)' : 'angewendet'}.` };
}

/** Ausstehende Behandlung der E-Mail ändern (z. B. falscher Zielordner) – nur solange n8n sie noch nicht ausgeführt hat */
export async function mailAktionAendern(vorgangId: number, aktion: MailAktion | null, wer: string) {
  const [v] = await DB`select id, status, mail_aktion, mail_erledigt_am from tco.eing_vorgaenge where id = ${vorgangId}`;
  if (!v) throw new BusinessError('Den Vorgang gibt es nicht (mehr).', 404);
  if (v.mail_erledigt_am) throw new BusinessError('Die Behandlung der E-Mail ist bereits ausgeführt.');
  const alt = v.mail_aktion as GeplanteMailAktion | null;
  const neu: GeplanteMailAktion | null = aktion && (aktion.art !== 'keine' || aktion.gelesen)
    ? { art: aktion.art, ordner: aktion.art === 'verschieben' ? aktion.ordner ?? '' : '', gelesen: !!aktion.gelesen, aufgaben: alt?.aufgaben ?? [] } : null;
  await DB`update tco.eing_vorgaenge set mail_aktion = ${neu ? DB.json(neu as never) : null} where id = ${vorgangId}`;
  // ohne Dokumente hängt der Status an der Behandlung (abgelegt ↔ ohne Regel)
  const status = await abschliessen(vorgangId);
  return { status, text: neu ? `Behandlung der E-Mail geändert (${wer}).` : 'Die E-Mail bleibt unverändert im Postfach.' };
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
