import { condense } from './format.js';

/**
 * Euroflex-Kontakte als Korrespondenten in Paperless (Korrespondent = Kontaktname „Name Namenszusatz“).
 * Abgleich vergleicht wie Paperless selbst: ohne Groß-/Kleinschreibung und ohne Rand-Leerzeichen.
 * Reine Logik ohne Datenbank – der Paperless-Zugang wird übergeben (testbar mit einer Attrappe).
 */
export interface KorrespondentQuelle {
  korrespondenten(): Promise<{ id: number; name: string }[]>;
  korrespondent(name: string, anlegen?: boolean): Promise<number | null>;
}
export interface KontaktName { adrnr: number; kundenname?: string | null; kundenname2?: string | null }

/** Name des Korrespondenten zum Kontakt – derselbe Name wie bei „Dokumente zum Kontakt“ */
export const korrespondentName = (a: { kundenname?: string | null; kundenname2?: string | null }) => condense(`${a.kundenname ?? ''} ${a.kundenname2 ?? ''}`);
const schluessel = (s: string) => s.trim().toLowerCase();

export interface AbgleichPlan {
  vorhanden: { adrnr: number; name: string; id: number }[];
  fehlend: { name: string; adrnr: number[] }[];
}

/** Welche Kontakte haben schon einen Korrespondenten, welche Namen fehlen (gleiche Namen nur einmal) */
export function abgleichPlanen(kontakte: KontaktName[], korrespondenten: { id: number; name: string }[]): AbgleichPlan {
  const da = new Map(korrespondenten.map((k) => [schluessel(k.name), k.id]));
  const vorhanden: AbgleichPlan['vorhanden'] = [];
  const fehlend = new Map<string, { name: string; adrnr: number[] }>();
  for (const k of kontakte) {
    const name = korrespondentName(k);
    if (!name) continue;
    const id = da.get(schluessel(name));
    if (id) { vorhanden.push({ adrnr: k.adrnr, name, id }); continue; }
    const f = fehlend.get(schluessel(name));
    if (f) f.adrnr.push(k.adrnr); else fehlend.set(schluessel(name), { name, adrnr: [k.adrnr] });
  }
  return { vorhanden, fehlend: [...fehlend.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')) };
}

export interface AbgleichErgebnis { vorhanden: number; angelegt: string[]; fehler: { name: string; meldung: string }[]; text: string }

/** Fehlende Korrespondenten anlegen; ein Fehler bei einem Namen bricht den Rest nicht ab */
export async function korrespondentenUebertragen(pl: KorrespondentQuelle, kontakte: KontaktName[]): Promise<AbgleichErgebnis> {
  const plan = abgleichPlanen(kontakte, await pl.korrespondenten());
  const angelegt: string[] = [];
  const fehler: AbgleichErgebnis['fehler'] = [];
  for (const f of plan.fehlend) {
    try {
      if (await pl.korrespondent(f.name, true)) angelegt.push(f.name);
    } catch (e) { fehler.push({ name: f.name, meldung: (e as Error).message }); }
  }
  const teile = [
    angelegt.length ? `${angelegt.length} Korrespondent(en) in Paperless angelegt` : 'Keine neuen Korrespondenten nötig',
    `${plan.vorhanden.length} Kontakt(e) waren schon vorhanden`,
    ...(fehler.length ? [`${fehler.length} Fehler: ${fehler.map((x) => `${x.name} (${x.meldung})`).join('; ')}`] : []),
  ];
  return { vorhanden: plan.vorhanden.length, angelegt, fehler, text: `${teile.join(', ')}.` };
}

export interface EinzelErgebnis { status: 'vorhanden' | 'angelegt' | 'ohne-name' | 'fehler'; id: number | null; name: string; text: string }

/** Einen Kontakt sofort prüfen und – falls nötig – als Korrespondent anlegen (beim Anlegen/Ändern des Kontakts) */
export async function korrespondentSichern(pl: KorrespondentQuelle, k: KontaktName): Promise<EinzelErgebnis> {
  const name = korrespondentName(k);
  if (!name) return { status: 'ohne-name', id: null, name, text: 'Kontakt ohne Namen – kein Korrespondent in Paperless.' };
  try {
    const id = await pl.korrespondent(name, false);
    if (id) return { status: 'vorhanden', id, name, text: `Korrespondent „${name}“ ist in Paperless vorhanden.` };
    const neu = await pl.korrespondent(name, true);
    return { status: 'angelegt', id: neu, name, text: `Korrespondent „${name}“ in Paperless angelegt.` };
  } catch (e) {
    return { status: 'fehler', id: null, name, text: `Korrespondent „${name}“ konnte nicht in Paperless angelegt werden: ${(e as Error).message}` };
  }
}
