/**
 * Geführte Vorgänge in „Meine Mitgliedschaft“ (#154): Mitglieder wechseln selbst den Mitgliedsbeitrag und schließen ein
 * (weiteres) Jugendtraining ab – für sich und für Personen, die über sie zahlen (Kinder). Jugendtraining außerdem für die
 * übrige Familie (familie.ts: gleicher Zahler oder Familienverknüpfung) – deren Verträge bleiben dabei verborgen, der Vertrag
 * läuft über den Zahler der Person, und der erhält die Unterlage. Die Kündigung läuft über
 * selbst.ts (kuendigen). Ausgeführt wird mit derselben Logik wie in der Mitgliederverwaltung (vorgaenge.ts), aber mit
 * festen Regeln statt freier Eingaben:
 *  - Beitragswechsel nur zwischen Mitgliedsbeiträgen, zum nächsten Halbjahr, Betrag laut Beitragsstamm; Jugendbeitrag nur
 *    bis 17 Jahre; Familienbeitrag und inaktive Mitgliedschaft nur über den Vorstand.
 *  - Jugendtraining nur für Personen, die zum Trainingsbeginn noch keine 21 Jahre alt sind, höchstens zwei Einheiten, Beginn zum nächsten Monatsersten, nur bei Lastschrift mit IBAN.
 * Seit der Freigabe durch den Vorstand werden beide Vorgänge nur eingereicht (aenderung.ts) und erst nach der Freigabe
 * ausgeführt; die Mitgliederinformation geht dann per E-Mail an das Mitglied.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { ART_JUGEND, leer, mitgliedLesen, vertraegeLesen, vertragsarten, vertragsbeginn, verweis, type Vertrag, type VertragsArt } from './logik.js';
import { alter, ALTER_JUGENDBEITRAG_BIS, ALTER_TRAINING_BIS, istFamilienbeitrag, istJugendbeitrag, kategorieVon, MAX_TRAINING } from '../antrag/logik.js';
import { eigeneAdrnr } from './selbst.js';
import { familienAdrnrs } from './familie.js';
import { vorgang, wechselAb, type Plan } from './vorgaenge.js';

export interface SelbstPerson {
  adrnr: string; name: string; ich: boolean; alter: number | null;
  /** gehört zur Familie, zahlt aber nicht über mich: nur Jugendtraining, Verträge werden nicht gezeigt */
  familie: boolean;
  vertraege: Vertrag[];
  /** laufender Mitgliedsbeitrag, der gewechselt werden kann, mit den möglichen neuen Beitragsarten */
  wechsel: { vertragnr: string; artname: string; betrag: number; turnus: string; arten: VertragsArt[] } | null;
  wechselHinweis: string | null;
  /** buchbare Trainingseinheiten */
  training: VertragsArt[];
  trainingHinweis: string | null;
  /** noch keine 21 Jahre alt – nur diese Personen stehen bei „Jugendtraining abschließen“ zur Auswahl */
  trainingAlter: boolean;
  /** Anzahl laufender Trainingseinheiten (nur Hinweis, keine Obergrenze) */
  trainingLaufend: number;
}
export type SelbstEingabe = { typ: 'BEITRAGSWECHSEL' | 'JUGENDTRAINING'; adrnr: string; art: string };

export async function selbstKontext(db: Db, benutzerId: string) {
  const eigene = await eigeneAdrnr(db, benutzerId);
  const h = heute();
  const ab = wechselAb(h);
  const trainingAb = vertragsbeginn(h, ART_JUGEND) ?? h;
  const ich = await mitgliedLesen(db, eigene);
  // Personen, die über mich zahlen – danach die übrige Familie (gleicher Zahler, Familienverknüpfung)
  const fam = await familienAdrnrs(db, eigene);
  const weitere = await db`select adrnr, (adrnrkih = ${eigene}) as ueber_mich from tco.mitglieder
                            where adrnr <> ${eigene} and (adrnrkih = ${eigene} or adrnr = any(${fam}::text[]))
                              and (austritt is null or austritt >= ${h})
                            order by coalesce(adrnrkih = ${eigene}, false) desc, geburtsdatum nulls last, adrnr`;
  const ueberMich = new Set(weitere.filter((w) => w.ueber_mich).map((w) => w.adrnr as string));
  const alleVertraege = (await vertraegeLesen(db, ich)).filter((v) => v.laeuft);
  const artenWechsel = (await vertragsarten(db, ab)).arten;
  const artenTraining = (await vertragsarten(db, trainingAb)).arten.filter((a) => kategorieVon(a.art, a.name) === 'TRAINING');
  // neue Verträge nur, wenn per Lastschrift eingezogen werden kann (eigenes Konto bzw. das des Zahlers der Person)
  const zahlerVon = async (m: Record<string, any>) => (verweis(m.adrnrkih) && verweis(m.adrnrkih) !== m.adrnr
    ? (verweis(m.adrnrkih) === eigene ? ich : await mitgliedLesen(db, verweis(m.adrnrkih))) : m);
  const zahlerIch = await zahlerVon(ich);
  const mailAn = new Map<string, string>();
  // eingereichte, noch nicht freigegebene Beitragswechsel (Freigabe durch den Vorstand, aenderung.ts)
  const wartend = new Set((await db`select adrnr from tco.mg_aenderungen where typ = 'BEITRAGSWECHSEL' and status = 'OFFEN'`).map((r) => r.adrnr as string));

  const personen: SelbstPerson[] = [];
  for (const adrnr of [eigene, ...weitere.map((w) => w.adrnr as string)]) {
    const m = adrnr === eigene ? ich : await mitgliedLesen(db, adrnr);
    const familie = adrnr !== eigene && !ueberMich.has(adrnr);
    // wie bisher: wer über mich zahlt, läuft über mein Konto (bzw. das meines Zahlers); die übrige Familie über ihren eigenen Zahler
    const zahler = familie ? await zahlerVon(m) : zahlerIch;
    const lastschrift = leer(zahler.zahlungsart) === 'L' && !!leer(zahler.iban1);
    mailAn.set(adrnr, familie ? zahler.adrnr as string : eigene);
    // Verträge der übrigen Familie nur intern (laufende Einheiten zählen) – angezeigt werden sie nicht
    const eigeneVt = familie ? (await vertraegeLesen(db, m)).filter((v) => v.laeuft && v.adrnr === adrnr) : alleVertraege.filter((v) => v.adrnr === adrnr);
    const vertraege = familie ? [] : eigeneVt;
    const p: SelbstPerson = {
      adrnr, name: condense(`${leer(m.vorname)} ${leer(m.nachname)}`), ich: adrnr === eigene, alter: m.geburtsdatum ? alter(m.geburtsdatum, h) : null,
      familie, vertraege, wechsel: null, wechselHinweis: null, training: [], trainingHinweis: null, trainingAlter: false, trainingLaufend: 0,
    };
    // ---- Beitragswechsel
    const beitrag = vertraege.find((v) => kategorieVon(v.art, v.artname) === 'MITGLIEDSCHAFT' && !v.vertragende);
    if (familie) p.wechselHinweis = 'Den Beitrag wechselt die Person selbst oder ihr Zahler.';
    else if (m.austritt) p.wechselHinweis = `Die Mitgliedschaft ist zum ${dat(m.austritt)} gekündigt.`;
    else if (!beitrag) p.wechselHinweis = 'Es läuft kein Mitgliedsbeitrag, der online gewechselt werden kann.';
    else if (istFamilienbeitrag(beitrag.artname)) p.wechselHinweis = 'Änderungen am Familienbeitrag bitte über den Vorstand.';
    else if (wartend.has(adrnr)) p.wechselHinweis = 'Ein Beitragswechsel ist bereits eingereicht und wartet auf die Freigabe durch den Vorstand.';
    else {
      const arten = artenWechsel.filter((a) => kategorieVon(a.art, a.name) === 'MITGLIEDSCHAFT' && a.art !== beitrag.art && !istFamilienbeitrag(a.name)
        && (!istJugendbeitrag(a.name) || (!!m.geburtsdatum && alter(m.geburtsdatum, ab) <= ALTER_JUGENDBEITRAG_BIS)));
      if (arten.length) p.wechsel = { vertragnr: beitrag.vertragnr, artname: beitrag.artname, betrag: beitrag.betrag, turnus: beitrag.sollstellung, arten };
      else p.wechselHinweis = 'Es gibt keine andere Beitragsart, in die online gewechselt werden kann.';
    }
    // ---- Jugendtraining
    const laufend = eigeneVt.filter((v) => kategorieVon(v.art, v.artname) === 'TRAINING' && (!v.vertragende || v.vertragende >= trainingAb));
    p.trainingLaufend = laufend.length;
    p.trainingAlter = !!m.geburtsdatum && alter(m.geburtsdatum, trainingAb) < ALTER_TRAINING_BIS;
    if (m.austritt && m.austritt < trainingAb) p.trainingHinweis = `Austritt zum ${dat(m.austritt)}.`;
    else if (!p.trainingAlter) p.trainingHinweis = `Jugendtraining kann nur abschließen, wer noch keine ${ALTER_TRAINING_BIS} Jahre alt ist.`;
    else if (!lastschrift) p.trainingHinweis = 'Für neue Verträge wird eine Bankverbindung mit SEPA-Lastschrift benötigt – bitte beim Vorstand melden.';
    else {
      // keine Obergrenze: jede angebotene Einheit ist buchbar, auch mehrfach (gedacht sind zwei je Person)
      p.training = artenTraining;
      if (!p.training.length) p.trainingHinweis = 'Derzeit wird kein Jugendtraining angeboten.';
    }
    personen.push(p);
  }
  return { eigene, personen, ab, trainingAb, maxTraining: MAX_TRAINING, mailAn };
}

/** prüft (ausfuehren = false) bzw. führt aus – nur Personen und Beitragsarten, die selbstKontext anbietet */
/** Angaben, mit denen der Vorgang später (nach der Freigabe) genau so ausgeführt wird */
export interface SelbstParameter { vertragnr: string | null; art: string; artname: string; ab: string }

export async function selbstVorgang(tx: Db, benutzerId: string, e: SelbstEingabe, ausfuehren: boolean, benutzer: string): Promise<Plan & { eigene: string; mailAn: string; parameter: SelbstParameter }> {
  const k = await selbstKontext(tx, benutzerId);
  const p = k.personen.find((x) => x.adrnr === e.adrnr);
  if (!p) throw new BusinessError('Die Person gehört nicht zu Ihrer Mitgliedschaft.', 403);
  const wer = `${benutzer} über „Meine Mitgliedschaft“`;
  if (e.typ === 'BEITRAGSWECHSEL') {
    if (!p.wechsel) throw new BusinessError(p.wechselHinweis ?? 'Ein Beitragswechsel ist nicht möglich.');
    const a = p.wechsel.arten.find((x) => x.art === e.art);
    if (!a) throw new BusinessError('Diese Beitragsart kann nicht online gewählt werden – bitte beim Vorstand melden.');
    const plan = await vorgang(tx, { typ: 'BEITRAGSWECHSEL', adrnr: p.adrnr, vertragnr: p.wechsel.vertragnr, art: a.art, ab: k.ab }, ausfuehren, wer, 'Portal');
    return { ...plan, eigene: k.eigene, mailAn: k.mailAn.get(p.adrnr) ?? k.eigene, parameter: { vertragnr: p.wechsel.vertragnr, art: a.art, artname: a.name, ab: k.ab } };
  }
  const a = p.training.find((x) => x.art === e.art);
  if (!a) throw new BusinessError(p.trainingHinweis ?? 'Diese Trainingseinheit kann nicht gebucht werden.');
  const plan = await vorgang(tx, { typ: 'JUGENDTRAINING', adrnr: p.adrnr, art: a.art, beginn: k.trainingAb, mehrfach: true }, ausfuehren, wer, 'Portal');
  return { ...plan, eigene: k.eigene, mailAn: k.mailAn.get(p.adrnr) ?? k.eigene, parameter: { vertragnr: null, art: a.art, artname: a.name, ab: k.trainingAb } };
}
