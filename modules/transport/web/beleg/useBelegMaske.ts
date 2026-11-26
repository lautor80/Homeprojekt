import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useLocation } from 'react-router-dom';
import type { Auftrag } from '../util';
import { KEIN_FRACHTAUFTRAG, belegErkennen } from './api';
import { belegMarke, belegUebernehmen, feldSetzen, offeneRueckfragen, type FeldId, type KandidatWert, type Rueckfrage, type Uebernahme, type Wert } from './uebernahme';
import { belegAbholen, type BelegQuelle, type BelegState } from './vormerkung';

/** Beleg, der gerade in der Maske steckt: Quelle, Ergebnis der Übernahme und die Entscheidungen des Benutzers zu Rückfragen */
export interface BelegStand {
  quelle: BelegQuelle;
  uebernahme: Uebernahme;
  /** Feld → gewählter Wert; null = Benutzer behält seine Eingabe */
  entschieden: ReadonlyMap<FeldId, Wert>;
}

export interface BelegMaske {
  stand: BelegStand | null;
  /** Erkennung läuft */
  laedt: boolean;
  /** Meldung über der Ablagezone (kein Frachtauftrag, Fehler der Erkennung) */
  meldung: { text: string; fehler: boolean } | null;
  meldungSchliessen: () => void;
  /** nach dem Speichern: Der Auftrag ist angelegt, aber der Beleg hängt nicht daran (bleibt stehen, bis er geschlossen wird) */
  hinweis: string | null;
  hinweisSchliessen: () => void;
  /** offene Rückfragen (aktueller Stand des Formulars) */
  offen: Rueckfrage[];
  /** true, sobald ein Beleg übernommen wurde – ein späteres Laden der leeren Vorlage darf die Maske dann nicht mehr leeren */
  angewendet: { readonly current: boolean };
  /** Datei lesen lassen und in die Maske übernehmen */
  erkennen: (datei: File) => Promise<void>;
  /** Kandidat einer Rückfrage ins Feld schreiben */
  waehlen: (r: Rueckfrage, k: KandidatWert) => void;
  /** Konflikt: eigene Eingabe behalten */
  behalten: (r: Rueckfrage) => void;
  /** Kennzeichnung der Felder unter einer Beschriftung */
  marke: (...ids: FeldId[]) => 'frage' | 'beleg' | null;
}

/**
 * Auftrag aus Beleg in der Erfassungsmaske (AuftragDetail, Neuanlage Frachtauftrag): holt einen von der Auftragsliste oder dem
 * Posteingang vorgemerkten Beleg ab, liest hier abgelegte Dateien und hält fest, was übernommen wurde und was noch zu klären ist.
 * Gespeichert wird nichts – das macht die Maske mit „Speichern“.
 */
export function useBelegMaske({ aktiv, a, setA, kundeWaehlen }: {
  /** nur in der Neuanlage eines Frachtauftrags */
  aktiv: boolean;
  a: Auftrag | null;
  setA: Dispatch<SetStateAction<Auftrag | null>>;
  /** Kunde setzen und seine Anschrift laden (wie die Auswahl im Feld) */
  kundeWaehlen: (adrnr: number) => void;
}): BelegMaske {
  const ort = useLocation();
  const [stand, setStand] = useState<BelegStand | null>(null);
  const [laedt, setLaedt] = useState(false);
  const [meldung, setMeldung] = useState<BelegMaske['meldung']>(null);
  const [hinweisZu, setHinweisZu] = useState(false);
  const angewendet = useRef(false);
  const form = useRef(a);
  form.current = a;
  const kunde = useRef(kundeWaehlen);
  kunde.current = kundeWaehlen;

  const anwenden = useCallback((quelle: BelegQuelle) => {
    const akt = form.current;
    if (!akt) return;
    if (!quelle.vorschlag.istFrachtauftrag) { setMeldung({ text: KEIN_FRACHTAUFTRAG, fehler: false }); return; }
    const u = belegUebernehmen(quelle.vorschlag, akt);
    angewendet.current = true;
    setMeldung(null);
    setA(u.form);
    setStand({ quelle, uebernahme: u, entschieden: new Map() });
    // Anschrift des Kunden nachladen (das Feld zeigt Straße, Ort, Telefon)
    if (u.form.kunde && u.form.kunde !== akt.kunde) kunde.current(u.form.kunde);
  }, [setA]);

  // Maske verlassen (z. B. nach dem Speichern zum gespeicherten Auftrag): der Beleg gehört nicht mehr dazu
  useEffect(() => {
    if (aktiv) return;
    angewendet.current = false;
    setStand(null);
  }, [aktiv]);

  // von der Auftragsliste bzw. dem Posteingang mitgegebener Beleg: einmal abholen, sobald die leere Maske geladen ist
  const geladen = !!a;
  const state = ort.state as BelegState | null;
  const schluessel = state?.beleg;
  const hinweis = !hinweisZu && typeof state?.hinweis === 'string' ? state.hinweis : null;
  useEffect(() => {
    if (!aktiv || !geladen) return;
    const q = belegAbholen(schluessel);
    if (q) anwenden(q);
  }, [aktiv, geladen, schluessel, anwenden]);

  const erkennen = useCallback(async (datei: File) => {
    setLaedt(true); setMeldung(null);
    try {
      anwenden({ vorschlag: await belegErkennen(datei), dateiName: datei.name, datei, eingang: null });
    } catch (e) {
      setMeldung({ text: `Der Beleg „${datei.name}“ konnte nicht gelesen werden: ${(e as Error).message}`, fehler: true });
    } finally { setLaedt(false); }
  }, [anwenden]);

  const entscheiden = (id: FeldId, wert: Wert) => setStand((s) => (s ? { ...s, entschieden: new Map(s.entschieden).set(id, wert) } : s));
  const waehlen = (r: Rueckfrage, k: KandidatWert) => {
    setA((x) => (x ? feldSetzen(x, r.id, k.wert) : x));
    entscheiden(r.id, k.wert);
    if (r.id === 'kunde' && typeof k.wert === 'number') kunde.current(k.wert);
  };
  const behalten = (r: Rueckfrage) => entscheiden(r.id, null);

  const offen = useMemo(() => (stand && a ? offeneRueckfragen(stand.uebernahme.rueckfragen, a, stand.entschieden) : []), [stand, a]);
  const marke = (...ids: FeldId[]) => (stand && a ? belegMarke(stand.uebernahme, a, stand.entschieden, ids) : null);

  return {
    stand, laedt, meldung, meldungSchliessen: () => setMeldung(null), hinweis, hinweisSchliessen: () => setHinweisZu(true),
    offen, angewendet, erkennen, waehlen, behalten, marke,
  };
}
