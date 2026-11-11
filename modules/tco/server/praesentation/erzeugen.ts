/**
 * Präsentation erzeugen (#146)
 *   Vorlage (Option B)  eigene, hochgeladene .pptx: alle Platzhalter, Diagramme und Tabellen werden gefüllt.
 *   Sammelkorb (Option C)  Einträge (Kennzahlen, Diagramme, Tabellen, Text, Kapitel) werden zu Folien der Standardvorlage
 *                       `assets/praesentation_standard.pptx` – je Eintrag wird der passende Baustein geklont und gefüllt,
 *                       aufeinanderfolgende Kennzahlen kommen zu viert auf eine Folie.
 */
import type { Db } from '../verein.js';
import { asset } from '../verein.js';
import { datenLaden, diagrammLaden, DIAGRAMME, tabelleLaden, TABELLEN, type Daten } from './bausteine.js';
import { folieEntfernen, folieKlonen, folienPfade, formenEntfernen, fuellen, lesen, ordnen, platzhalter, rahmenBreite, schreiben, type Diagramm, type Tabelle } from './pptx.js';

export interface Eingaben { jahr: number; titel?: string; untertitel?: string; texte?: Record<string, string> }
export type KorbArt = 'KPI' | 'DIAGRAMM' | 'TABELLE' | 'TEXT' | 'KAPITEL';
export interface KorbEintrag { id: string; art: KorbArt; schluessel?: string | null; titel?: string | null; text?: string | null }

/** Diagramme/Tabellen einer Datei vorab laden (asynchron), damit das Füllen synchron bleibt */
async function objekteLaden(db: Db, pl: string[], jahr: number) {
  const dia = new Map<string, Diagramm>();
  const tab = new Map<string, Tabelle>();
  for (const p of pl) {
    const m = /^(DIAGRAMM|TABELLE):(.+)$/.exec(p);
    if (!m) continue;
    if (m[1] === 'DIAGRAMM' && DIAGRAMME[m[2]] && !dia.has(m[2])) dia.set(m[2], (await diagrammLaden(db, m[2], jahr))!);
    if (m[1] === 'TABELLE' && TABELLEN[m[2]] && !tab.has(m[2])) { const t = await tabelleLaden(db, m[2], jahr); if (t) tab.set(m[2], t); }
  }
  return { dia, tab };
}

/** Option B: hochgeladene Vorlage füllen */
export async function ausVorlage(db: Db, datei: Buffer, e: Eingaben): Promise<{ datei: Buffer; daten: Daten }> {
  const t = lesen(datei);
  const daten = await datenLaden(db, e.jahr, e);
  const { dia, tab } = await objekteLaden(db, platzhalter(t), e.jahr);
  fuellen(t, { werte: (k) => daten.werte.get(k), diagramm: (k) => dia.get(k), tabelle: (k) => tab.get(k) });
  return { datei: schreiben(t), daten };
}

/** Bausteine der Standardvorlage (Folienposition 1-basiert) */
const B = { TITEL: 1, KENNZAHLEN: 2, LINIE: 3, SAEULEN: 4, TABELLE: 5, TEXT: 6, KAPITEL: 7, ENDE: 8 } as const;

interface Folie { baustein: number; titel: string; text: string; kpis?: string[]; diagramm?: string; tabelle?: string }

/** Korb → Folienplan; Kennzahlen in Vierergruppen */
export function folienplan(eintraege: KorbEintrag[]): Folie[] {
  const out: Folie[] = [];
  let gruppe: Folie | null = null;
  for (const e of eintraege) {
    if (e.art === 'KPI' && e.schluessel) {
      if (!gruppe || gruppe.kpis!.length >= 4 || (e.titel?.trim() && gruppe.kpis!.length)) {
        gruppe = { baustein: B.KENNZAHLEN, titel: e.titel?.trim() || 'Kennzahlen', text: '', kpis: [] };
        out.push(gruppe);
      }
      gruppe.kpis!.push(e.schluessel);
      if (e.text?.trim()) gruppe.text = gruppe.text ? `${gruppe.text}\n${e.text.trim()}` : e.text.trim();
      continue;
    }
    gruppe = null;
    if (e.art === 'DIAGRAMM' && e.schluessel && DIAGRAMME[e.schluessel]) {
      const d = DIAGRAMME[e.schluessel];
      out.push({ baustein: d.art === 'LINIE' ? B.LINIE : B.SAEULEN, titel: e.titel?.trim() || d.titel, text: e.text?.trim() ?? '', diagramm: e.schluessel });
    } else if (e.art === 'TABELLE' && e.schluessel && TABELLEN[e.schluessel]) {
      out.push({ baustein: B.TABELLE, titel: e.titel?.trim() || TABELLEN[e.schluessel].titel, text: e.text?.trim() ?? '', tabelle: e.schluessel });
    } else if (e.art === 'TEXT') {
      out.push({ baustein: B.TEXT, titel: e.titel?.trim() || '', text: e.text?.trim() ?? '' });
    } else if (e.art === 'KAPITEL') {
      out.push({ baustein: B.KAPITEL, titel: e.titel?.trim() || '', text: e.text?.trim() ?? '' });
    }
  }
  return out;
}

/** Option C: Sammelkorb als Präsentation in der Standardvorlage */
export async function ausKorb(db: Db, eintraege: KorbEintrag[], e: Eingaben): Promise<Buffer> {
  const t = lesen(asset('praesentation_standard.pptx'));
  const daten = await datenLaden(db, e.jahr, e);
  const basis = folienPfade(t);
  const plan = folienplan(eintraege);
  const reihe: string[] = [basis[B.TITEL - 1]];
  for (const f of plan) {
    const neu = folieKlonen(t, basis[f.baustein - 1]);
    const lokal = new Map<string, string>([['folie.titel', f.titel], ['folie.text', f.text]]);
    (f.kpis ?? []).forEach((k, i) => {
      for (const s of ['', '.einheit', '.titel', '.text']) lokal.set(`K${i + 1}${s}`, daten.werte.get(`${k}${s}`) ?? (s === '' ? '–' : ''));
    });
    const dia = f.diagramm ? await diagrammLaden(db, f.diagramm, e.jahr) : undefined;
    const tab = f.tabelle ? await tabelleLaden(db, f.tabelle, e.jahr) : undefined;
    fuellen(t, { werte: (k) => lokal.get(k) ?? daten.werte.get(k), diagramm: () => dia, tabelle: () => tab ?? { kopf: ['Hinweis'], zeilen: [['Keine Daten']] } }, neu);
    const weg: string[] = [];
    if (f.kpis) for (let i = f.kpis.length + 1; i <= 4; i++) weg.push(`Kachel ${i}`);
    if (!f.text) weg.push('Kommentar');
    if (!f.text && (f.diagramm || f.baustein === B.TEXT)) weg.push('Kommentar Hintergrund', 'Text Hintergrund');
    formenEntfernen(t, neu, weg);
    // ohne Kommentar: Diagramm auf volle Breite (12,1″ = 11 064 240 EMU)
    if (f.diagramm && !f.text) rahmenBreite(t, neu, 11_064_240);
    reihe.push(neu);
  }
  reihe.push(basis[B.ENDE - 1]);
  for (let i = B.KENNZAHLEN; i < B.ENDE; i++) folieEntfernen(t, basis[i - 1]);
  ordnen(t, reihe);
  // Titelfolie, Abschluss und Fußzeilen (Layouts)
  fuellen(t, { werte: (k) => daten.werte.get(k) });
  return schreiben(t);
}
