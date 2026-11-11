/**
 * Vereinsübersicht (Dashboard) – Port von Z2UI5_CL_TCO_REPORTING (Startseite der SAP-App).
 * GET /dashboard liefert alle Kennzahlen und Diagrammdaten als JSON, Details und der
 * Beitragsstufenwechsel haben eigene Endpunkte.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB } from '../verein.js';
import { addTage, dat, heute, runden } from '../format.js';
import {
  auswahlBereinigen, chartClubhaus, chartHalle, chartHalleJahre, chartJugend, chartMtgJahre, chartMtgMonate, datenJahre,
  jahreAufbauen, jahreAuswahl, jahreText, JUG_GESAMT, JUG_TRAINER, type KeyText,
} from './charts.js';
import { arbeitsvorrat } from './arbeitsvorrat.js';
import { BENUTZER_ZEITRAEUME, benutzerVerlauf, type BenutzerZeitraum } from './benutzer.js';
import { geldkonten, kontoKey, liquiditaet, monatsverlauf } from './finanzen.js';
import {
  bswVertragWechseln, collectClubhaus, collectFinanzen, collectHalle, collectJugend, collectMitglieder,
  detailBeitragswechsel, detailClubhausOp, detailClubhausUmsatz, detailHalleOffen, HAL_ZEITRAEUME, type Bereich, type HalZeitraum,
} from './kpi.js';

export const P_DASH = { display: 'tco.dashboard:display', edit: 'tco.dashboard:edit' };

const jahr = z.coerce.number().int().min(2000).max(2100);
/** Komma-Liste „2025,2026“ → Array */
const liste = z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');

/** Geschäftsjahre zur Auswahl: Jahre mit Clubhaus-Forderungen oder FI-Buchungen, immer das laufende Jahr (absteigend) */
async function geschaeftsjahre(): Promise<number[]> {
  const rows = await DB`select jahr from tco.forderungen union select jahr from tco.fibuchungen where jahr is not null`;
  const s = new Set<number>(rows.map((r) => Number(r.jahr)).filter((j) => j >= 2000));
  s.add(Number(heute().slice(0, 4)));
  return [...s].sort((a, b) => b - a);
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', { preHandler: requireAuth(P_DASH.display) }, async (req) => {
    const q = z.object({
      jahr: jahr.optional(), jugJahre: liste, halJahre: liste, finJahre: liste, finKonten: liste,
      jugAnsicht: z.enum([JUG_GESAMT, JUG_TRAINER]).default(JUG_TRAINER),
      halZeitraum: z.enum(Object.keys(HAL_ZEITRAEUME) as [HalZeitraum, ...HalZeitraum[]]).default('SAISON'),
    }).parse(req.query);
    const h = heute();
    const hj = Number(h.slice(0, 4));
    const jahre = await geschaeftsjahre();
    const gj = q.jahr && jahre.includes(q.jahr) ? q.jahr : jahre.includes(hj) ? hj : jahre[0];

    const bereiche: Bereich[] = [
      { key: 'MITGLIEDER', title: 'Mitglieder', kpis: await collectMitglieder(DB, gj) },
      { key: 'FINANZEN', title: 'Finanzen', kpis: await collectFinanzen(DB, gj) },
      { key: 'CLUBHAUS', title: 'Clubhaus', kpis: await collectClubhaus(DB, gj) },
      { key: 'JUGEND', title: 'Jugend', kpis: await collectJugend(DB, gj) },
      { key: 'HALLE', title: 'Halle', kpis: await collectHalle(DB, q.halZeitraum) },
    ];

    // Jahresauswahl der Diagramme (load_cmp_years / fin_auswahl_laden)
    const dj = await datenJahre(DB);
    const jugJahre = jahreAufbauen(dj.jugend[0], dj.jugend[1], gj);
    const jugSel = auswahlBereinigen(jugJahre, q.jugJahre, gj);
    const halJahre = jahreAufbauen(dj.halle[0], dj.halle[1], gj);
    const halSel = auswahlBereinigen(halJahre, q.halJahre, gj);
    const finJahre = jahreAufbauen(dj.fin[0], dj.fin[1], gj);
    const finSel = auswahlBereinigen(finJahre, q.finJahre, gj);
    // Geldkonten mit Bestand oder Bewegung; Vorbelegung alle
    const konten: KeyText[] = (await geldkonten(DB, Math.max(hj, gj))).map((g) => ({ key: kontoKey(g.konto), text: `${kontoKey(g.konto)} ${g.name}`.trim() }));
    let kontenSel = [...new Set(q.finKonten.map(kontoKey))].filter((k) => konten.some((x) => x.key === k));
    if (!kontenSel.length) kontenSel = konten.map((k) => k.key);

    // Finanzen: analytische Card „Saldo Konten“ (render_fin_card)
    const finInt = jahreAuswahl(finSel, gj);
    const mv = await monatsverlauf(DB, finInt, kontenSel);
    let ein = 0, aus = 0, eb = mv.anfangsbestand, stand: string | null = null;
    for (const v of mv.verlauf) {
      if (v.zukunft) continue;                      // Kontostand = Monatsende des letzten Monats mit Ist-Werten
      ein += v.einnahmen; aus += v.ausgaben; eb = v.bestand;
      stand = `${String(v.monat).padStart(2, '0')}/${v.jahr}`;
    }
    const kontenText = kontenSel.length === konten.length ? 'alle Geldkonten'
      : kontenSel.length === 1 ? konten.find((k) => k.key === kontenSel[0])?.text ?? kontenSel[0]
        : `${kontenSel.length} von ${konten.length} Geldkonten`;
    const finanzen = {
      jahre: finJahre, jahreSel: finSel, konten, kontenSel, jahreText: jahreText(finInt), kontenText, mehrjahr: finInt.length > 1,
      anfangsbestand: mv.anfangsbestand, anfangsjahr: finInt[0] ?? gj, einnahmen: runden(ein), ausgaben: runden(aus), ergebnis: runden(ein - aus),
      kontostand: runden(eb), stand, verlauf: mv.verlauf,
      // Liquidität zum aktuellen Monat (unabhängig von der Auswahl): Geldkonten + offene Forderungen + Kredite
      liquiditaet: await liquiditaet(DB, hj, Number(h.slice(5, 7))),
    };

    const jugInt = jahreAuswahl(jugSel, gj);
    const halInt = jahreAuswahl(halSel, gj);
    return {
      jahr: gj, jahre, heute: h, bereiche,
      charts: {
        mitgliederMonate: { title: `Mitgliederentwicklung ${gj}`, nameLine: 'Mitglieder', namePos: 'Eintritte', nameNeg: 'Austritte', data: await chartMtgMonate(DB, gj) },
        mitgliederJahre: { title: `Mitgliederentwicklung ${hj - 9} - ${hj}`, nameLine: 'Mitglieder zum Jahresende', namePos: 'Eintritte', nameNeg: 'Austritte', data: await chartMtgJahre(DB) },
        clubhaus: { title: `Clubheimerträge ${gj} je Monat`, name1: 'Umsatz VK brutto', name2: 'Rohertrag', data: await chartClubhaus(DB, gj) },
        finanzen,
        jugend: { jahre: jugJahre, jahreSel: jugSel, ansicht: q.jugAnsicht, ...(await chartJugend(DB, jugInt, gj, q.jugAnsicht)) },
        halle: {
          jahre: halJahre, jahreSel: halSel, ...(await chartHalle(DB, halInt, gj)),
          jahreVerlauf: { title: `Hallenbuchungen ${hj - 4} - ${hj} in Gesamtstunden`, name1: 'Gebuchte Stunden (Abo + Einzelbuchungen)', data: await chartHalleJahre(DB) },
        },
      },
    };
  });

  /** Arbeitsvorrat: offene Vorgänge (je nach Berechtigung des Benutzers) */
  app.get('/dashboard/arbeitsvorrat', { preHandler: requireAuth(P_DASH.display) }, async (req) => arbeitsvorrat(DB, req));
  /** registrierte Benutzer über die Zeit (#30): TAG (30 Tage), WOCHE (26), MONAT (24), JAHR, GESAMT */
  app.get('/dashboard/benutzer', { preHandler: requireAuth(P_DASH.display) }, async (req) => {
    const q = z.object({ zeitraum: z.enum(Object.keys(BENUTZER_ZEITRAEUME) as [BenutzerZeitraum, ...BenutzerZeitraum[]]).default('MONAT') }).parse(req.query);
    return benutzerVerlauf(DB, q.zeitraum, heute());
  });

  /** Detail-Popup einer Kennzahl */
  app.get('/dashboard/detail/:key', { preHandler: requireAuth(P_DASH.display) }, async (req) => {
    const { key } = z.object({ key: z.string() }).parse(req.params);
    const q = z.object({ jahr: jahr.default(Number(heute().slice(0, 4))) }).parse(req.query);
    switch (key) {
      case 'CLUB_OP': return detailClubhausOp(DB, q.jahr);
      case 'CLUB_UMSATZ': return detailClubhausUmsatz(DB, q.jahr);
      case 'MTG_JUBILAEUM': return detailBeitragswechsel(DB);
      case 'HAL_ABR': return detailHalleOffen(DB);
      default: return { title: `Details ${key}`, head: ['Hinweis'], zeilen: [], info: 'Für diese Kennzahl ist noch keine Datenquelle angebunden.' };
    }
  });

  /**
   * Beitragsstufenwechsel: Jugendverträge zum Stichtag beenden, neue Verträge ab Folgetag anlegen.
   * Jede Zeile wird einzeln umgestellt (eigene Transaktion je Mitglied, wie in ABAP), Fehler werden gesammelt.
   */
  app.post('/dashboard/beitragswechsel', { preHandler: requireAuth(P_DASH.edit) }, async (req) => {
    const b = z.object({
      stichtag: datum,
      zeilen: z.array(z.object({ adrnr: z.string().min(1), vertragnr: z.string().min(1), art: z.string().trim().min(1), name: z.string().default('') })).min(1, 'Bitte mindestens bei einem Mitglied eine neue Beitragsstufe auswählen.'),
    }).parse(req.body);
    const fehler: string[] = [];
    const ok: { adrnr: string; vertragnr: string; name: string; vertragnrNeu: string; stufe: string }[] = [];
    for (const zeile of b.zeilen) {
      try {
        const r = await change(req, (tx) => bswVertragWechseln(tx, { adrnr: zeile.adrnr, vertragnr: zeile.vertragnr, artNeu: zeile.art, stichtag: b.stichtag }),
          { action: 'BEITRAGSWECHSEL', reason: `Jugendvertrag ${zeile.vertragnr} zum ${dat(b.stichtag)} beendet, neue Beitragsstufe ${zeile.art}` });
        ok.push({ ...zeile, ...r });
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        fehler.push(`${zeile.name || zeile.adrnr}: ${e.message}`);
      }
    }
    const ab = dat(addTage(b.stichtag, 1));
    const text = ok.length === 1 && !fehler.length
      ? `${ok[0].name || ok[0].adrnr}: Jugendvertrag zum ${dat(b.stichtag)} beendet, neuer Vertrag „${ok[0].stufe}“ ab ${ab} angelegt.`
      : `${ok.length} Mitglied(er) umgestellt: Jugendvertrag zum ${dat(b.stichtag)} beendet, neue Verträge ab ${ab} angelegt.`;
    return { ok: ok.length, umgestellt: ok, fehler, text: fehler.length ? `${ok.length} Mitglied(er) umgestellt, ${fehler.length} nicht umgestellt:\n${fehler.join('\n')}` : text };
  });
}
