import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { change, requireAuth } from '../../../../server/src/auth.js';
import { BusinessError } from '../../../../server/src/errors.js';
import { DB, liste, paperless, plAktiv, vereinLesen } from '../verein.js';
import { addTage, heute } from '../format.js';
import {
  buchungenLesen, gegenkontoHistorie, kontenLesen, kontostand, offeneRechnungen, RG_STATUS, salden, zahlungen,
} from './daten.js';
import {
  belegEntfernen, belegeZuordnen, notizAnlegen, rechnungVerknuepfen, stornieren, umsaetzeBuchen, type Umsatz,
} from './buchen.js';
import { bankAbgleich } from './bank.js';
import { belegLesen, offeneBelege, zuordnungLoesen, zuordnungMelden, type OffenerBeleg } from './belege.js';

export const P_FI = {
  display: 'tco.fi:display',
  buchen: 'tco.fi:buchen',
  storno: 'tco.fi:storno',
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
    };
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
    return { internenr: p.nr, zeilen, belege: belege.map((b) => Number(b.doknr)).filter(Boolean), notizen, storniertDurch: storno?.internenr ?? null };
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
    return offeneBelege(v);
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
    const d = await paperless(await vereinLesen()).download(id);
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
      try { offen = await offeneBelege(v); } catch (e) { hinweise.push(`Belegvorschlag ohne Paperless: ${(e as Error).message}`); }
    }
    const buf = Buffer.from(b.data.replace(/^data:[^,]*,/, ''), 'base64');
    const r = await bankAbgleich(DB, b.konto, buf, offen);
    return { ...r, hinweise: [...r.hinweise, ...hinweise] };
  });

  app.post('/fi/buchen', { preHandler: requireAuth(P_FI.buchen) }, async (req) => {
    const b = z.object({
      konto: z.string().min(1), iban: z.string().nullish(), umsaetze: z.array(umsatzSchema).min(1, 'Keine Umsätze ausgewählt'),
    }).parse(req.body);
    const umsaetze: Umsatz[] = b.umsaetze.map((u) => ({
      konto: b.konto, ...u,
      // leere Zusatzpositionen (z. B. SumUp-Gebühr 0) entfallen
      positionen: u.positionen.length > 1 ? u.positionen.filter((p) => p.betrag !== 0) : u.positionen,
    }));
    const v = await vereinLesen();
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
    const warnungen = r.beleg && plAktiv(v) ? await zuordnungMelden(v, [r.beleg], b.internenr) : [];
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
