import { type Db, type Verein } from '../verein.js';
import { condense } from '../format.js';
import { kontaktLesen, type Kontakt } from '../kommunikation.js';
import { adrnrErmitteln, positionenLesen, rechnungenLesen } from './daten.js';
import { mailTexte, mailVersand, type Schreiber } from './versand.js';

/**
 * Sammelversand von Hallenrechnungen (#29): alle Rechnungen „In Bearbeitung“ werden vorgeschlagen,
 * je Empfänger ist ersichtlich, ob eine E-Mail-Adresse gepflegt ist. Nach Auswahl und Freigabe wird
 * je Empfänger gedruckt (Ablage in Paperless) und per E-Mail versendet – mit den bestehenden Funktionen
 * des Einzelversands (mailVersand). Versandweg ist ausschließlich E-Mail.
 */

export interface VersandVorschlag {
  rgnr: string;
  kunde: string;
  name: string;
  adrnr: string | null;
  betrag: number;
  positionen: number;
  angelegt_am: string | null;
  /** gepflegte E-Mail-Adresse des Empfängers – leer, wenn keine vorhanden ist */
  email: string;
  vorname: string;
  /** war schon einmal versendet und wurde wieder eröffnet */
  wiedereroeffnet: boolean;
  /** Grund, weshalb die Rechnung nicht versendet werden kann (sonst null) */
  hinweis: string | null;
}

/** alle Rechnungen im Status „In Bearbeitung“ mit Empfänger und E-Mail-Adresse */
export async function versandVorschlag(db: Db): Promise<VersandVorschlag[]> {
  const rechnungen = await rechnungenLesen(db, { status: ['1'], druckVon: null, druckBis: null, buchungen: false });
  const kontakte = new Map<string, Kontakt | null>();
  const out: VersandVorschlag[] = [];
  for (const r of rechnungen) {
    const adrnr = r.adrnr ?? await adrnrErmitteln(db, r.kunde);
    if (adrnr && !kontakte.has(adrnr)) kontakte.set(adrnr, await kontaktLesen(db, adrnr));
    const k = adrnr ? kontakte.get(adrnr) ?? null : null;
    const email = k?.email?.trim() ?? '';
    const hinweis = !k ? 'Keine Kundendaten – der Name passt zu keinem Mitglied und keinem Kunden'
      : !r.anzahl ? 'Rechnung hat keine Positionen'
        : !email ? 'Keine E-Mail-Adresse gepflegt'
          : null;
    out.push({
      rgnr: r.rgnr_txt, kunde: r.kunde, name: k ? condense(`${k.vorname} ${k.nachname}`) || r.kunde : r.kunde, adrnr: adrnr ?? null,
      betrag: Number(r.betrag), positionen: r.anzahl, angelegt_am: r.angelegt_am, email, vorname: k?.vorname ?? '',
      wiedereroeffnet: r.wiedereroeffnet, hinweis,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'de') || a.rgnr.localeCompare(b.rgnr));
}

export interface VersandZeile { quelle: string; ok: boolean; text: string; rgnrs: string[] }

/**
 * Freigegebene Rechnungen drucken und per E-Mail versenden – je Empfänger eine E-Mail mit allen
 * seinen gewählten Rechnungen. Fehler eines Empfängers halten die übrigen nicht auf; das Ergebnis
 * ist ein Protokoll je Empfänger.
 */
export async function sammelversand(db: Db, v: Verein, w: Schreiber, d: { rgnrs: string[]; benutzer: string }): Promise<VersandZeile[]> {
  const gewaehlt = [...new Set(d.rgnrs)];
  const vorschlag = new Map((await versandVorschlag(db)).map((x) => [x.rgnr, x]));
  const zeilen: VersandZeile[] = [];
  const gruppen = new Map<string, VersandVorschlag[]>();
  for (const rgnr of gewaehlt) {
    const x = vorschlag.get(rgnr);
    if (!x) {
      zeilen.push({ quelle: rgnr, ok: false, text: `Rechnung ${rgnr} ist nicht (mehr) im Status „In Bearbeitung“ – nicht versendet`, rgnrs: [rgnr] });
    } else if (x.hinweis) {
      zeilen.push({ quelle: `${x.name} (${rgnr})`, ok: false, text: `${x.hinweis} – nicht versendet`, rgnrs: [rgnr] });
    } else {
      const key = `${x.adrnr}|${x.email.toLowerCase()}`;
      gruppen.set(key, [...(gruppen.get(key) ?? []), x]);
    }
  }
  for (const liste of gruppen.values()) {
    const rgnrs = liste.map((x) => x.rgnr);
    const { name, email, vorname } = liste[0];
    const quelle = `${name} (${rgnrs.join(', ')})`;
    try {
      // Positionen müssen druckbar sein, bevor die erste Rechnung des Empfängers gedruckt wird
      for (const rgnr of rgnrs) {
        if (!(await positionenLesen(db, rgnr)).length) throw new Error(`Rechnung ${rgnr} hat keine Positionen`);
      }
      const { betreff, text } = mailTexte(v, vorname, rgnrs);
      const r = await mailVersand(db, v, w, { rgnrs, an: email, betreff, text, neudruck: true, entwurf: false, benutzer: d.benutzer });
      zeilen.push({ quelle, ok: r.status === 'gesendet', text: [r.text, ...r.warnungen].join(' · '), rgnrs });
    } catch (e) {
      zeilen.push({ quelle, ok: false, text: (e as Error).message, rgnrs });
    }
  }
  return zeilen;
}
