import type { FastifyInstance, FastifyRequest } from 'fastify';
import { rechnungAufteilung } from '../halle/daten.js';
import { z } from 'zod';
import { can, change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, liste, paperless, plAktiv, vereinLesen, type Verein } from '../verein.js';
import { fiDokumentPruefen } from '../dokumentfreigabe.js';
import { addTage, heute } from '../format.js';
import {
  buchungenLesen, gegenkontoHistorie, kontenLesen, kontostand, offeneRechnungen, RG_STATUS, salden, zahlungen,
} from './daten.js';
import {
  belegEntfernen, belegeZuordnen, notizAnlegen, rechnungVerknuepfen, stornieren, umsaetzeBuchen, type Umsatz,
} from './buchen.js';
import { bankAbgleich } from './bank.js';
import { abgeschlossenBis, abschliessen, oeffnen, periodenLesen } from './perioden.js';
import { P_BANK, bankSchutz } from '../bankdaten.js';
import { belegLesen, offeneBelege, zuordnungLoesen, zuordnungMelden, type OffenerBeleg } from './belege.js';
import { ueberweisungBestaetigen, ueberweisungDokument, ueberweisungZahlung, ueberweisungsBelege } from './ueberweisung.js';
import { dateiPruefen, dekodieren } from '../upload/logik.js';
import { PaperlessError } from '../../../../server/src/lib/paperless.js';
import { kontextAblegen } from '../../../../server/src/lib/paperless-mapping.js';
import { K } from '../paperless-kontexte.js';

/**
 * Belege, die im Portal schon einer Buchung zugeordnet sind, in Paperless aber noch „SAP“ leer haben
 * (z. B. Rechnungs-PDF einer im Bankimport zugeordneten Hallenrechnung vor der Korrektur): Kennzeichen nachziehen
 * und nicht mehr als offen anbieten.
 */
async function sapNachziehen(v: Verein, offen: OffenerBeleg[]): Promise<OffenerBeleg[]> {
  if (!offen.length) return offen;
  const ids = offen.map((b) => String(b.id));
  const zu = await DB`select ltrim(doknr, '0') as dok, min(internenr) as internenr from tco.fipapermap
                       where ltrim(doknr, '0') in ${DB(ids)} group by 1`;
  if (!zu.length) return offen;
  const fertig = new Set<number>();
  for (const z of zu) {
    const w = await zuordnungMelden(v, [Number(z.dok)], String(z.internenr), true);
    if (!w.length) fertig.add(Number(z.dok));
  }
  return offen.filter((b) => !fertig.has(b.id));
}

export const P_FI = {
  display: 'tco.fi:display',
  buchen: 'tco.fi:buchen',
  storno: 'tco.fi:storno',
  /** #3: Perioden abschließen und wieder öffnen */
  periode: 'tco.fi:periode',
};

const datum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT');
const nr = z.string().regex(/^\d{1,10}$/, 'Interne Belegnummer');
const benutzer = (req: FastifyRequest) => req.user?.displayName || req.user?.username || 'unbekannt';

const positionSchema = z.object({
  gkonto: z.string().trim().default(''),
  betrag: z.coerce.number(),
  text: z.string().max(60).nullish(),
  rgnr: z.string().nullish(),
});
const umsatzSchema = z.object({
  datum, text: z.string().trim().min(1, 'Buchungstext fehlt').max(60), betrag: z.coerce.number(),
  positionen: z.array(positionSchema).min(1, 'Gegenkonto fehlt'),
  belege: z.array(z.coerce.number().int().positive()).default([]),
  notiz: z.string().max(255).nullish(),
  laufid: z.string().regex(/^\d+$/).nullish(),
});

export async function fiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- Lesen
  app.get('/fi/init', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { jahr } = z.object({ jahr: z.coerce.number().int().default(new Date().getFullYear()) }).parse(req.query);
    const v = await vereinLesen();
    return {
      konten: await kontenLesen(DB, jahr),
      bankkonten: liste(v.fi_bankkonten),
      manuellKonten: liste(v.fi_manuell_konten),
      paperless: plAktiv(v),
      /** #3: letzter abgeschlossener Monat (JJJJ-MM) – Buchungen bis dahin sind gesperrt */
      abgeschlossenBis: await abgeschlossenBis(DB),
    };
  });

  // ---------------------------------------------------------------- Perioden (#3)
  app.get('/fi/perioden', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { jahr } = z.object({ jahr: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }).parse(req.query);
    return periodenLesen(DB, jahr);
  });
  const periode = z.object({ jahr: z.coerce.number().int().min(2000).max(2100), monat: z.coerce.number().int().min(1).max(12) });
  app.post('/fi/perioden/abschliessen', { preHandler: requireAuth(P_FI.periode) }, async (req) => {
    const p = periode.parse(req.body);
    return { text: await change(req, (tx) => abschliessen(tx, p.jahr, p.monat), { action: 'PERIODE_ABSCHLUSS', reason: `${p.monat}/${p.jahr}` }) };
  });
  app.post('/fi/perioden/oeffnen', { preHandler: requireAuth(P_FI.periode) }, async (req) => {
    const p = periode.extend({ grund: z.string().trim().min(1, 'Bitte einen Grund angeben').max(200) }).parse(req.body);
    return { text: await change(req, (tx) => oeffnen(tx, p.jahr, p.monat), { action: 'PERIODE_OEFFNEN', reason: p.grund }) };
  });

  app.get('/fi/buchungen', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const q = z.object({ von: datum, bis: datum, konto: z.string().optional() }).parse(req.query);
    if (q.von > q.bis) throw new BusinessError('Der Zeitraum ist vertauscht (Von nach Bis)');
    const konto = q.konto || null;
    return {
      zeilen: await buchungenLesen(DB, q.von, q.bis, konto),
      salden: konto ? await salden(DB, konto, Number(q.bis.slice(0, 4))) : null,
      rechnungen: await offeneRechnungen(DB),
    };
  });

  app.get('/fi/buchung/:nr', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const p = z.object({ nr }).parse(req.params);
    const zeilen = await DB`
      select b.konto, b.posnr, b.datum::text as datum, b.text, (coalesce(b.soll, 0) - coalesce(b.haben, 0))::float8 as betrag,
             b.gkonto, b.belnr, b.rgnr_txt, b.storno_zu, b.erfasst_von, coalesce(k.name, '') as konto_name
        from tco.fibuchungen b left join tco.fikonten k on k.konto = b.konto
       where b.internenr = ${p.nr} order by b.posnr = 0 desc, b.konto, b.posnr`;
    if (!zeilen.length) throw new BusinessError(`Buchung ${p.nr} nicht gefunden`);
    const belege = await DB`select ltrim(doknr, '0') as doknr from tco.fipapermap where internenr = ${p.nr} order by 1`;
    const notizen = await DB`select notiz_id as id, notiz, erstellt_von, erstellt_am from tco.finotiz where internenr = ${p.nr} order by erstellt_am desc`;
    const [storno] = await DB`select internenr from tco.fibuchungen where storno_zu = ${p.nr} limit 1`;
    // verknüpfte Objekte über dieselben Paperless-Dokumente (z. B. Rechnung einer Schadensmeldung, #205)
    const ids = belege.map((b) => Number(b.doknr)).filter(Boolean);
    const objekte = ids.length ? (await DB`
      select distinct m.id, m.nummer, a.bezeichnung as anlage, k.bezeichnung as kategorie, d.doc_id
        from tco.ih_dokument d join tco.ih_meldung m on m.id = d.meldung_id
        join tco.ih_anlage a on a.id = m.anlage_id join tco.ih_kategorie k on k.id = m.kategorie_id
       where d.doc_id = any(${ids}) order by m.nummer`).map((o) => ({
      art: 'Schadensmeldung', nummer: o.nummer as string, text: `${o.anlage} – ${o.kategorie}`, doc_id: o.doc_id as number, pfad: `/tco/instandhaltung?id=${o.id}`,
    })) : [];
    return { internenr: p.nr, zeilen, belege: ids, notizen, storniertDurch: storno?.internenr ?? null, objekte };
  });

  app.get('/fi/zahlungen', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { rgnr } = z.object({ rgnr: z.string().optional() }).parse(req.query);
    return zahlungen(DB, rgnr || null);
  });

  app.get('/fi/kontostand', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const q = z.object({ konto: z.string().min(1), stichtag: datum.optional() }).parse(req.query);
    const stichtag = q.stichtag ?? heute();
    const [l] = await DB`select max(datum)::text as d from tco.fibuchungen where konto = ${q.konto} and datum <= ${stichtag}`;
    return { konto: q.konto, stichtag, betrag: await kontostand(DB, q.konto, stichtag), letzteBuchung: l?.d ?? null };
  });

  app.get('/fi/gegenkonto', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const q = z.object({ gkonto: z.string().min(1), internenr: nr }).parse(req.query);
    return gegenkontoHistorie(DB, q.gkonto, q.internenr, addTage(heute(), -366));
  });

  // ---------------------------------------------------------------- Paperless-Belege
  app.get('/fi/belege/offen', { preHandler: requireAuth(P_FI.display) }, async () => {
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (TC Oberthal → Stammdaten).');
    return sapNachziehen(v, await offeneBelege(v));
  });

  /**
   * Belege mit Folgeaktion „Überweisung an Einreicher“ und leerem Feld „SAP“ – Liste, Vorschau und QR-Code zur Überweisung.
   * Die Zahlungsdaten (IBAN des Einreichers aus dem Mitgliederstamm) verlangen zusätzlich „Bankdaten anzeigen“.
   */
  app.get('/fi/ueberweisungen', { preHandler: requireAuth(P_FI.display) }, async () => {
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (TC Oberthal → Stammdaten).');
    return ueberweisungsBelege(v, DB);
  });
  app.get('/fi/ueberweisungen/:id/pdf', { preHandler: requireAuth(P_FI.display) }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const v = await vereinLesen();
    await ueberweisungDokument(v, id);
    const d = await paperless(v).download(id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });
  app.get('/fi/ueberweisungen/:id/zahlung', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const q = z.object({
      betrag: z.string().trim().max(20).optional().transform((s) => (s ? Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s) : null))
        .refine((n) => n === null || (Number.isFinite(n) && n >= 0.01 && n <= 999_999_999.99), 'Bitte einen gültigen Betrag angeben.'),
      zweck: z.string().trim().max(140).optional(),
      // von Hand gewähltes Mitglied, wenn sich der Einreicher nicht zuordnen lässt
      adrnr: z.string().trim().max(20).optional(),
    }).parse(req.query);
    if (!can(req, P_BANK.display)) throw new BusinessError('Für die Zahlungsdaten ist die Berechtigung „Bankdaten anzeigen“ nötig (tco.bankdaten:display).', 403);
    return ueberweisungZahlung(await vereinLesen(), DB, id, q.betrag === null ? null : Math.round(q.betrag * 100) / 100, q.zweck ?? null, q.adrnr || null);
  });
  /** Überweisung bestätigen: Custom Field „Status“ des Belegs in Paperless auf „gezahlt“ setzen */
  app.post('/fi/ueberweisungen/:id/gezahlt', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const v = await vereinLesen();
    return change(req, (tx) => ueberweisungBestaetigen(v, tx, id, req.user!.displayName), { action: 'UPLOAD_ERLEDIGT', reason: String(id) });
  });
  /** Live-Suche für die Auswahl des Empfängers: Mitglieder nach Name oder Mitgliedsnummer */
  app.get('/fi/ueberweisungen/mitglieder', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(80).default('') }).parse(req.query);
    const { mitgliederSuchen } = await import('../upload/zahlung.js');
    return mitgliederSuchen(DB, q);
  });

  app.get('/fi/belege/:id', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive().max(999999) }).parse(req.params);
    const v = await vereinLesen();
    let b: OffenerBeleg;
    try {
      b = await belegLesen(v, id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new BusinessError(status === 404 ? `Dokument ${id} wurde in Paperless nicht gefunden.` : (e as Error).message);
    }
    const zu = await DB`select distinct internenr from tco.fipapermap where ltrim(doknr, '0') = ${String(id)} order by 1`;
    return { ...b, zugeordnet: zu.map((r) => r.internenr) };
  });

  app.get('/fi/belege/:id/pdf', { preHandler: requireAuth(P_FI.display) }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const v = await vereinLesen();
    await fiDokumentPruefen(DB, v, id);
    const d = await paperless(v).download(id);
    return reply.type(d.contentType).header('content-disposition', `inline; filename="${encodeURIComponent(d.filename)}"`).send(d.data);
  });

  app.get('/fi/belege/:id/notizen', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const v = await vereinLesen();
    const pl = paperless(v);
    return { notizen: await pl.notizen(id), url: await pl.ansichtUrl(id) };
  });

  // ---------------------------------------------------------------- Buchen
  app.post('/fi/bank/lesen', { preHandler: requireAuth(P_FI.buchen), bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const b = z.object({ konto: z.string().min(1), data: z.string().min(1) }).parse(req.body);
    const v = await vereinLesen();
    if (!liste(v.fi_bankkonten).includes(b.konto)) throw new BusinessError(`Für Konto ${b.konto} gibt es keine Bankdatei – bitte manuell buchen.`);
    let offen: OffenerBeleg[] = [];
    const hinweise: string[] = [];
    if (plAktiv(v)) {
      try { offen = await sapNachziehen(v, await offeneBelege(v)); } catch (e) { hinweise.push(`Belegvorschlag ohne Paperless: ${(e as Error).message}`); }
    }
    const buf = Buffer.from(b.data.replace(/^data:[^,]*,/, ''), 'base64');
    const r = await bankAbgleich(DB, b.konto, buf, offen);
    // IBANs Dritter im Verwendungszweck nur mit Bankdaten-Berechtigung im Klartext (eigene Konto-IBAN bleibt)
    const sb = bankSchutz(req);
    const umsaetze = sb.klar ? r.umsaetze : r.umsaetze.map((u) => ({ ...u, zweck: sb.freitext(u.zweck), buchungsText: sb.freitext(u.buchungsText) }));
    return { ...r, umsaetze, hinweise: [...r.hinweise, ...hinweise] };
  });

  app.post('/fi/buchen', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({
      konto: z.string().min(1), iban: z.string().nullish(), umsaetze: z.array(umsatzSchema).min(1, 'Keine Umsätze ausgewählt'),
      /** bank = Umsätze aus der Bankdatei, manuell = Kasse und Konten ohne Bankdatei; ohne Angabe aus den Stammdaten abgeleitet */
      modus: z.enum(['bank', 'manuell']).optional(),
    }).parse(req.body);
    const v = await vereinLesen();
    const bank = liste(v.fi_bankkonten);
    const manuellKonten = liste(v.fi_manuell_konten);
    const modus = b.modus ?? (bank.includes(b.konto) ? 'bank' : 'manuell');
    if (modus === 'bank' && !bank.includes(b.konto)) {
      throw new BusinessError(`Konto ${b.konto} ist in den Stammdaten nicht als Konto mit Bankdatei hinterlegt (TC Oberthal → Einstellungen → Stammdaten → FI-Belege).`);
    }
    if (modus === 'manuell' && !manuellKonten.includes(b.konto)) {
      throw new BusinessError(`Konto ${b.konto} ist in den Stammdaten nicht für manuelle Buchungen hinterlegt (TC Oberthal → Einstellungen → Stammdaten → FI-Belege).`);
    }
    const umsaetze: Umsatz[] = b.umsaetze.map((u) => ({
      konto: b.konto, ...u,
      // leere Zusatzpositionen (z. B. SumUp-Gebühr 0) entfallen
      positionen: u.positionen.length > 1 ? u.positionen.filter((p) => p.betrag !== 0) : u.positionen,
      // Sollstellungs-Läufe gibt es nur aus der Bankdatei
      laufid: modus === 'bank' ? u.laufid : null,
    }));
    const erg = await change(req, async (tx) => {
      const r = await umsaetzeBuchen(tx, umsaetze, benutzer(req));
      if (b.iban) {
        await tx`insert into tco.fibankiban (konto, iban) values (${b.konto}, ${b.iban.replace(/\s/g, '').toUpperCase()})
                 on conflict (konto) do nothing`;
      }
      return r;
    }, { action: 'BUCHEN' });
    const warn: string[] = [];
    if (plAktiv(v)) {
      for (const g of erg) if (g.belege.length) warn.push(...(await zuordnungMelden(v, g.belege, g.internenr)));
    }
    const nrn = erg.map((g) => g.internenr);
    const rg = erg.reduce((s, g) => s + g.rechnungen.length, 0);
    const bl = erg.reduce((s, g) => s + g.belege.length, 0);
    return {
      gebucht: erg, warnungen: warn,
      text: `${erg.length} Buchung(en) erstellt (intern ${nrn[0]}${nrn.length > 1 ? ` bis ${nrn[nrn.length - 1]}` : ''})`
        + (rg ? `, ${rg} Rechnung(en) verknüpft` : '') + (bl ? `, ${bl} Beleg(e) zugeordnet` : ''),
    };
  });

  app.post('/fi/storno', { preHandler: requireAuth(P_FI.storno) }, async (req) => {
    const b = z.object({ internenr: nr, grund: z.string().trim().min(1, 'Bitte einen Stornogrund angeben').max(200) }).parse(req.body);
    return change(req, (tx) => stornieren(tx, b.internenr, b.grund, benutzer(req)), { action: 'STORNO', reason: b.grund });
  });

  app.post('/fi/rechnung', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({ internenr: nr, konto: z.string(), posnr: z.coerce.number().int(), rgnr: z.string().min(1) }).parse(req.body);
    const v = await vereinLesen();
    const r = await change(req, (tx) => rechnungVerknuepfen(tx, b), { action: 'RECHNUNG_ZAHLUNG' });
    const warnungen: string[] = r.beleg && plAktiv(v) ? await zuordnungMelden(v, [r.beleg], b.internenr) : [];
    // Nachträgliche Zuordnung bucht nicht um: bei mehreren Erlöskonten auf die Splitbuchung hinweisen
    const teile = await rechnungAufteilung(DB, b.rgnr);
    if (teile.length > 1) {
      warnungen.push(`Rechnung ${b.rgnr} enthält Positionen auf mehreren Erlöskonten (${teile.map((t) => `${t.konto}: ${t.betrag.toFixed(2).replace('.', ',')} €`).join(', ')}). `
        + 'Die bestehende Buchung bleibt unverändert – für die Aufteilung die Buchung stornieren und im Bankimport mit Hallenrechnung neu buchen.');
    }
    return { ...r, statusText: RG_STATUS[r.status], warnungen };
  });

  app.post('/fi/belege/zuordnen', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({
      internenr: z.array(nr).min(1), doks: z.array(z.coerce.number().int().positive()).min(1, 'Bitte mindestens ein Dokument auswählen'),
    }).parse(req.body);
    const v = await vereinLesen();
    const neu = await change(req, async (tx) => {
      const out: { internenr: string; doks: number[] }[] = [];
      for (const n of b.internenr) {
        const [da] = await tx`select 1 from tco.fibuchungen where internenr = ${n} limit 1`;
        if (!da) throw new BusinessError(`Buchung ${n} nicht gefunden`);
        out.push({ internenr: n, doks: await belegeZuordnen(tx, n, b.doks) });
      }
      return out;
    }, { action: 'BELEG_ZUORDNEN' });
    const warnungen: string[] = [];
    // Belegnummer in Paperless je Ziel korrekt (E2); Mehrfachzuordnung: erste Buchung bleibt eingetragen
    if (plAktiv(v)) {
      for (const [i, z] of neu.entries()) if (z.doks.length) warnungen.push(...(await zuordnungMelden(v, z.doks, z.internenr, i > 0)));
    }
    const n = neu.reduce((s, z) => s + z.doks.length, 0);
    return { text: `${n} Zuordnung(en) gespeichert`, warnungen };
  });

  /**
   * Datei per Ablagefeld/Drag & Drop/Screenshot als FI-Beleg nach Paperless (Dokumenttyp und Speicherpfad
   * aus den Stammdaten). Mit Buchung(en): sofort zuordnen; ohne: offener Beleg (Vorschlag im Bankimport).
   */
  app.post('/fi/belege/hochladen', { preHandler: requireAuth(P_FI.buchen), bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      datei: z.string().min(1).max(200), inhalt: z.string().min(1, 'Die Datei ist leer.'),
      internenr: z.array(nr).default([]), titel: z.string().max(200).nullish(),
    }).parse(req.body);
    const v = await vereinLesen();
    if (!plAktiv(v)) throw new BusinessError('Paperless ist nicht eingerichtet (TC Oberthal → Stammdaten).');
    for (const n of b.internenr) {
      const [da] = await DB`select 1 from tco.fibuchungen where internenr = ${n} limit 1`;
      if (!da) throw new BusinessError(`Buchung ${n} nicht gefunden`);
    }
    const pl = paperless(v);
    const name = b.datei.split(/[\\/]/).pop()!.trim();
    const { daten, mime } = dekodieren(name, b.inhalt);
    dateiPruefen(name, daten.length);
    // Felder laut zentraler Paperless-Zuordnung (Kontext „FI-Beleg“)
    let r: { id: number | null; warnungen: string[] };
    try {
      r = await kontextAblegen(pl, K.fiBeleg, 'tco', {
        datei: name, buchungen: b.internenr.join(', '), fi_belegtyp: liste(v.fi_beleg_typen)[0] ?? '', fi_belegpfad: liste(v.fi_beleg_pfad)[0] ?? '',
        heute: heute(), benutzer: benutzer(req), verein: v.name,
      }, daten, name, { mime, benutzer: benutzer(req), ueberschreiben: b.titel ? { title: b.titel } : undefined });
    } catch (e) {
      if (e instanceof PaperlessError) return { id: null, text: e.message, warnungen: [], zugeordnet: [] };
      throw e;
    }
    if (!r.id) return { id: null, text: 'Übertragen – Paperless verarbeitet die Datei noch', warnungen: r.warnungen, zugeordnet: [] };
    const id = r.id;
    if (!b.internenr.length) return { id, text: `Beleg ${id} in Paperless abgelegt – offen, wird beim Bankimport vorgeschlagen`, warnungen: r.warnungen, zugeordnet: [] };
    await change(req, async (tx) => { for (const n of b.internenr) await belegeZuordnen(tx, n, [id]); }, { action: 'BELEG_ZUORDNEN' });
    const warnungen: string[] = [...r.warnungen];
    for (const [i, n] of b.internenr.entries()) warnungen.push(...(await zuordnungMelden(v, [id], n, i > 0)));
    return { id, text: `Beleg ${id} abgelegt und Buchung ${b.internenr.join(', ')} zugeordnet`, warnungen, zugeordnet: b.internenr };
  });

  app.post('/fi/belege/entfernen', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({ internenr: nr, dok: z.coerce.number().int().positive(), grund: z.string().trim().min(1, 'Bitte eine Begründung angeben') }).parse(req.body);
    const v = await vereinLesen();
    const rest = await change(req, async (tx) => {
      const r = await belegEntfernen(tx, b.internenr, b.dok);
      await notizAnlegen(tx, b.internenr, `Beleg ${b.dok} entfernt: ${b.grund}`, benutzer(req));
      return r;
    }, { action: 'BELEG_ENTFERNEN', reason: b.grund });
    const warnungen = rest === 0 && plAktiv(v) ? await zuordnungLoesen(v, b.dok) : [];
    return { text: `Beleg ${b.dok} von Buchung ${b.internenr} entfernt`, warnungen };
  });

  /** Belege einer früheren Buchung übernehmen (Gegenkonto-Historie, wiederkehrende Zahlung) */
  app.post('/fi/belege/uebernehmen', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({ internenr: nr, von: nr }).parse(req.body);
    const v = await vereinLesen();
    const neu = await change(req, async (tx) => {
      const doks = (await tx`select ltrim(doknr, '0') as d from tco.fipapermap where internenr = ${b.von}`)
        .map((r) => Number(r.d)).filter(Boolean);
      if (!doks.length) throw new BusinessError(`Buchung ${b.von} hat keine Belege`);
      return belegeZuordnen(tx, b.internenr, doks);
    }, { action: 'BELEG_ZUORDNEN' });
    // Feld „Belegnummer“ bleibt bei der ursprünglichen Buchung (E5)
    const warnungen = neu.length && plAktiv(v) ? await zuordnungMelden(v, neu, b.internenr, true) : [];
    return { text: `${neu.length} Beleg(e) von Buchung ${b.von} verknüpft`, warnungen };
  });

  // ---------------------------------------------------------------- Notizen
  app.post('/fi/notiz', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const b = z.object({ internenr: nr, text: z.string().trim().min(1, 'Leere Notiz').max(255) }).parse(req.body);
    await change(req, (tx) => notizAnlegen(tx, b.internenr, b.text, benutzer(req)));
    return { ok: true };
  });

  app.delete('/fi/notiz', { preHandler: requireAuth(P_FI.display) }, async (req) => {
    const b = z.object({ internenr: nr, id: z.string().min(1) }).parse(req.body);
    const n = await change(req, (tx) => tx`
      delete from tco.finotiz where internenr = ${b.internenr} and notiz_id = ${b.id} and erstellt_von = ${benutzer(req)}`);
    if (!n.count) throw new BusinessError('Nur eigene Notizen können gelöscht werden');
    return { ok: true };
  });
}
