/**
 * Geführte Vorgänge in „Meine Mitgliedschaft“ (#154): Mitglieder wechseln selbst den Mitgliedsbeitrag und schließen ein
 * (weiteres) Jugendtraining ab – für sich und für Personen, die über sie zahlen (Kinder). Die Kündigung läuft über
 * selbst.ts (kuendigen). Ausgeführt wird mit derselben Logik wie in der Mitgliederverwaltung (vorgaenge.ts), aber mit
 * festen Regeln statt freier Eingaben:
 *  - Beitragswechsel nur zwischen Mitgliedsbeiträgen, zum nächsten Halbjahr, Betrag laut Beitragsstamm; Jugendbeitrag nur
 *    bis 17 Jahre; Familienbeitrag und inaktive Mitgliedschaft nur über den Vorstand.
 *  - Jugendtraining nur für Personen, die zum Trainingsbeginn noch keine 21 Jahre alt sind, höchstens zwei Einheiten, Beginn zum nächsten Monatsersten, nur bei Lastschrift mit IBAN.
 * Der Vorstand wird über Notiz und Kopie der E-Mail informiert.
 */
import { BusinessError } from '../../../../server/src/errors.js';
import type { Db } from '../verein.js';
import { condense, dat, heute } from '../format.js';
import { ART_JUGEND, leer, mitgliedLesen, vertraegeLesen, vertragsarten, vertragsbeginn, verweis, type Vertrag, type VertragsArt } from './logik.js';
import { alter, ALTER_JUGENDBEITRAG_BIS, ALTER_TRAINING_BIS, istFamilienbeitrag, istJugendbeitrag, kategorieVon, MAX_TRAINING } from '../antrag/logik.js';
import { eigeneAdrnr } from './selbst.js';
import { vorgang, wechselAb, type Plan } from './vorgaenge.js';

export interface SelbstPerson {
  adrnr: string; name: string; ich: boolean; alter: number | null;
  vertraege: Vertrag[];
  /** laufender Mitgliedsbeitrag, der gewechselt werden kann, mit den möglichen neuen Beitragsarten */
  wechsel: { vertragnr: string; artname: string; betrag: number; turnus: string; arten: VertragsArt[] } | null;
  wechselHinweis: string | null;
  /** buchbare Trainingseinheiten */
  training: VertragsArt[];
  trainingHinweis: string | null;
  /** noch keine 21 Jahre alt – nur diese Personen stehen bei „Jugendtraining abschließen“ zur Auswahl */
  trainingAlter: boolean;
}
export type SelbstEingabe = { typ: 'BEITRAGSWECHSEL' | 'JUGENDTRAINING'; adrnr: string; art: string };

export async function selbstKontext(db: Db, benutzerId: string) {
  const eigene = await eigeneAdrnr(db, benutzerId);
  const h = heute();
  const ab = wechselAb(h);
  const trainingAb = vertragsbeginn(h, ART_JUGEND) ?? h;
  const ich = await mitgliedLesen(db, eigene);
  const weitere = await db`select adrnr from tco.mitglieder where adrnrkih = ${eigene} and adrnr <> ${eigene}
                             and (austritt is null or austritt >= ${h}) order by geburtsdatum nulls last, adrnr`;
  const alleVertraege = (await vertraegeLesen(db, ich)).filter((v) => v.laeuft);
  const artenWechsel = (await vertragsarten(db, ab)).arten;
  const artenTraining = (await vertragsarten(db, trainingAb)).arten.filter((a) => kategorieVon(a.art, a.name) === 'TRAINING');
  // neue Verträge nur, wenn per Lastschrift eingezogen werden kann (eigenes Konto bzw. das des Zahlers)
  const zahler = verweis(ich.adrnrkih) ? await mitgliedLesen(db, verweis(ich.adrnrkih)) : ich;
  const lastschrift = leer(zahler.zahlungsart) === 'L' && !!leer(zahler.iban1);

  const personen: SelbstPerson[] = [];
  for (const adrnr of [eigene, ...weitere.map((w) => w.adrnr as string)]) {
    const m = adrnr === eigene ? ich : await mitgliedLesen(db, adrnr);
    const vertraege = alleVertraege.filter((v) => v.adrnr === adrnr);
    const p: SelbstPerson = {
      adrnr, name: condense(`${leer(m.vorname)} ${leer(m.nachname)}`), ich: adrnr === eigene, alter: m.geburtsdatum ? alter(m.geburtsdatum, h) : null,
      vertraege, wechsel: null, wechselHinweis: null, training: [], trainingHinweis: null, trainingAlter: false,
    };
    // ---- Beitragswechsel
    const beitrag = vertraege.find((v) => kategorieVon(v.art, v.artname) === 'MITGLIEDSCHAFT' && !v.vertragende);
    if (m.austritt) p.wechselHinweis = `Die Mitgliedschaft ist zum ${dat(m.austritt)} gekündigt.`;
    else if (!beitrag) p.wechselHinweis = 'Es läuft kein Mitgliedsbeitrag, der online gewechselt werden kann.';
    else if (istFamilienbeitrag(beitrag.artname)) p.wechselHinweis = 'Änderungen am Familienbeitrag bitte über den Vorstand.';
    else {
      const arten = artenWechsel.filter((a) => kategorieVon(a.art, a.name) === 'MITGLIEDSCHAFT' && a.art !== beitrag.art && !istFamilienbeitrag(a.name)
        && (!istJugendbeitrag(a.name) || (!!m.geburtsdatum && alter(m.geburtsdatum, ab) <= ALTER_JUGENDBEITRAG_BIS)));
      if (arten.length) p.wechsel = { vertragnr: beitrag.vertragnr, artname: beitrag.artname, betrag: beitrag.betrag, turnus: beitrag.sollstellung, arten };
      else p.wechselHinweis = 'Es gibt keine andere Beitragsart, in die online gewechselt werden kann.';
    }
    // ---- Jugendtraining
    const laufend = vertraege.filter((v) => kategorieVon(v.art, v.artname) === 'TRAINING' && (!v.vertragende || v.vertragende >= trainingAb));
    p.trainingAlter = !!m.geburtsdatum && alter(m.geburtsdatum, trainingAb) < ALTER_TRAINING_BIS;
    if (m.austritt && m.austritt < trainingAb) p.trainingHinweis = `Austritt zum ${dat(m.austritt)}.`;
    else if (!p.trainingAlter) p.trainingHinweis = `Jugendtraining kann nur abschließen, wer noch keine ${ALTER_TRAINING_BIS} Jahre alt ist.`;
    else if (laufend.length >= MAX_TRAINING) p.trainingHinweis = `Es laufen bereits ${MAX_TRAINING} Trainingseinheiten.`;
    else if (!lastschrift) p.trainingHinweis = 'Für neue Verträge wird eine Bankverbindung mit SEPA-Lastschrift benötigt – bitte beim Vorstand melden.';
    else {
      p.training = artenTraining.filter((a) => !laufend.some((v) => v.art === a.art));
      if (!p.training.length) p.trainingHinweis = 'Alle angebotenen Trainingseinheiten sind bereits gebucht.';
    }
    personen.push(p);
  }
  return { eigene, personen, ab, trainingAb, maxTraining: MAX_TRAINING };
}

/** prüft (ausfuehren = false) bzw. führt aus – nur Personen und Beitragsarten, die selbstKontext anbietet */
export async function selbstVorgang(tx: Db, benutzerId: string, e: SelbstEingabe, ausfuehren: boolean, benutzer: string): Promise<Plan & { eigene: string }> {
  const k = await selbstKontext(tx, benutzerId);
  const p = k.personen.find((x) => x.adrnr === e.adrnr);
  if (!p) throw new BusinessError('Die Person gehört nicht zu Ihrer Mitgliedschaft.', 403);
  const wer = `${benutzer} über „Meine Mitgliedschaft“`;
  if (e.typ === 'BEITRAGSWECHSEL') {
    if (!p.wechsel) throw new BusinessError(p.wechselHinweis ?? 'Ein Beitragswechsel ist nicht möglich.');
    const a = p.wechsel.arten.find((x) => x.art === e.art);
    if (!a) throw new BusinessError('Diese Beitragsart kann nicht online gewählt werden – bitte beim Vorstand melden.');
    const plan = await vorgang(tx, { typ: 'BEITRAGSWECHSEL', adrnr: p.adrnr, vertragnr: p.wechsel.vertragnr, art: a.art, ab: k.ab }, ausfuehren, wer, 'Portal');
    return { ...plan, eigene: k.eigene };
  }
  const a = p.training.find((x) => x.art === e.art);
  if (!a) throw new BusinessError(p.trainingHinweis ?? 'Diese Trainingseinheit kann nicht gebucht werden.');
  const plan = await vorgang(tx, { typ: 'JUGENDTRAINING', adrnr: p.adrnr, art: a.art, beginn: k.trainingAb }, ausfuehren, wer, 'Portal');
  return { ...plan, eigene: k.eigene };
}
