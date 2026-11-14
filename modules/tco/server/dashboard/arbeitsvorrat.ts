/**
 * Arbeitsvorrat TC Oberthal: offene Vorgänge, die jemand im Verein erledigen muss. Der Kern zeigt sie auf der Startseite
 * (ServerModule.arbeitsvorrat, #232 V2), die Vereinsübersicht als Ausschnitt.
 * Jeder Eintrag erscheint nur, wenn der Benutzer die zugehörige App bedienen darf.
 *
 * Gruppierung (bereich) nach Zuständigkeit im Verein:
 *  - Jugendwart:  alles rund um das Schnuppertraining – jede neue Anmeldung einzeln
 *  - Kassenwart:  heute erfasste Hallenbuchungen (mit den einzelnen Buchungen darunter), freigegebene Zeitnachweise der Trainer,
 *                 neue Mitgliedsanträge und Vertragswechsel – je Antrag
 *  - Vorstand:    neue Registrierungen und deren Freigabe; Kündigungen der Mitglieder freigeben, Bestätigung prüfen und senden (#232)
 *  - Hallenwart:  Halle aufsperren (Buchungen ohne Hallenschlüssel)
 *  - Instandhaltung: jede offene Schadensmeldung einzeln (#205), farbig nach Auswirkung
 *  - Dokumente:   Dokumenteneingang – Vorgänge mit Fehler und zu prüfende
 *  - Clubhaus: wie bisher (Einträge der Administration liefert der Kern)
 *  - dazu gemeldete Ereignisse (Hinweise, server/src/lib/hinweise.ts) unter der Zuständigkeit, die die meldende Stelle nennt
 */
import type { FastifyRequest } from 'fastify';
import { can } from '../../../../server/src/auth.js';
import type { Db } from '../verein.js';
import { monatsname } from '../jt/logik.js';
import { ADRNR_ZU_BENUTZER, HALLENWART } from '../platz/schluessel.js';
import { aufgaben as ihAufgaben, P_IH } from '../instandhaltung/logik.js';
import { aufgaben as schluesselAufgaben, P_SCHL } from '../schluessel/logik.js';

// Der Typ gehört seit #232 (V2) dem Kern – der Arbeitsvorrat steht auf der Startseite für alle Anwendungen
export type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import type { Aufgabe } from '../../../../server/src/lib/arbeitsvorrat.js';
import { hinweisAufgaben } from '../../../../server/src/lib/hinweise.js';

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function arbeitsvorrat(db: Db, req: FastifyRequest): Promise<Aufgabe[]> {
  const out: Aufgabe[] = [];

  // Instandhaltung (#205): jede offene Schadensmeldung sofort und einzeln – Sicherheitsrisiko rot, unbespielbar orange
  if (can(req, P_IH.display)) out.push(...await ihAufgaben(db));

  // Hallenschlüssel (#215): Ausgaben ohne Quittung nach der Frist, unbestätigte Rückgaben, Ausgetretene mit Schlüssel
  if (can(req, P_SCHL.display)) out.push(...await schluesselAufgaben(db));

  // Kassenwart: vom Trainer freigegebene, noch nicht (vollständig) bezahlte Zeitnachweise
  if (can(req, 'tco.jt:display')) {
    const rows = await db`
      select d.adrnr, d.monat, d.belegnr, coalesce(d.stunden, 0)::float8 as stunden, coalesce(d.betrag, 0)::float8 as betrag,
             coalesce(d.bezahlt_betrag, 0)::float8 as bezahlt_betrag,
             to_char(d.freigegeben_am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am,
             coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), d.adrnr) as name,
             d.oeffnung_angefragt_am is not null as oeffnung, d.oeffnung_grund
        from tco.jt_doku d left join tco.mitglieder m on m.adrnr = d.adrnr
       where d.freigegeben_am is not null and (d.bezahlt_am is null or coalesce(d.bezahlt_betrag, 0) < coalesce(d.betrag, 0))
       order by d.freigegeben_am`;
    for (const r of rows) {
      const offen = Math.max(0, Number(r.betrag) - Number(r.bezahlt_betrag));
      out.push(r.oeffnung ? {
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Kassenwart', icon: 'unlocked', state: 'Critical',
        titel: `${r.name} bittet um Öffnung von ${monatsname(r.monat)}`,
        text: r.oeffnung_grund ? `Grund: ${r.oeffnung_grund}` : 'Freigabe zurücknehmen, damit der Trainer korrigieren kann.',
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
      } : {
        key: `JT:${r.adrnr}:${r.monat}`, bereich: 'Kassenwart', icon: 'family-care', state: 'Information',
        titel: `Zeitnachweis ${r.name} – ${monatsname(r.monat)} freigegeben`,
        text: `${Number(r.stunden).toLocaleString('de-DE')} Std., ${eur(offen)} € zur Zahlung${r.belegnr ? ` · ${r.belegnr}` : ''}`,
        datum: r.am, pfad: `/tco/jugendtraining?monat=${r.monat}&tab=abr`, betrag: offen,
      });
    }
  }

  // Clubhaus-Verzehr: offene Gastbelege (nicht kassiert) und überfällige Sammelabrechnungen
  if (can(req, 'tco.verzehr:display')) {
    const [g] = await db`select count(*)::int as n, coalesce(sum(betrag), 0)::float8 as betrag, to_char(min(datum), 'YYYY-MM-DD') as seit
                           from tco.vz_belege where art = 'GAST' and status = 'OFFEN' and datum < current_date`;
    if (g?.n) {
      out.push({
        key: 'VZ_GAST_OFFEN', bereich: 'Clubhaus', icon: 'meal', state: 'Critical',
        titel: `${g.n} Gastbeleg${g.n === 1 ? '' : 'e'} nicht kassiert`,
        text: `${eur(Number(g.betrag))} € aus vergangenen Abenden – an der Theke kassieren oder stornieren.`,
        datum: g.seit, pfad: '/tco/theke', betrag: Number(g.betrag),
      });
    }
    const [f] = await db`select count(*)::int as n, coalesce(sum(betrag), 0)::float8 as betrag, to_char(min(faellig), 'YYYY-MM-DD') as seit
                           from tco.vz_belege where art = 'SAMMEL' and status = 'GESTELLT' and faellig < current_date and zahlart <> 'LASTSCHRIFT'`;
    if (f?.n) {
      out.push({
        key: 'VZ_UEBERFAELLIG', bereich: 'Clubhaus', icon: 'receipt', state: 'Critical',
        titel: `${f.n} Verzehrabrechnung${f.n === 1 ? '' : 'en'} überfällig`,
        text: `${eur(Number(f.betrag))} € offen – Zahlungseingang prüfen oder erinnern.`,
        datum: f.seit, pfad: '/tco/verzehrbuch?tab=belege', betrag: Number(f.betrag),
      });
    }
    const [o] = await db`select count(distinct adrnr)::int as n, coalesce(sum(betrag), 0)::float8 as betrag from tco.vz_posten
                           where adrnr is not null and rgnr is null and storniert_am is null and datum < date_trunc('month', current_date)`;
    if (o?.n) {
      out.push({
        key: 'VZ_ABSCHLUSS', bereich: 'Clubhaus', icon: 'sales-order', state: 'Information',
        titel: 'Monatsabschluss Verzehr steht an',
        text: `${o.n} Mitglied${o.n === 1 ? '' : 'er'} mit ${eur(Number(o.betrag))} € offenem Verzehr aus Vormonaten.`,
        datum: null, pfad: '/tco/verzehrbuch?tab=abschluss', betrag: Number(o.betrag),
      });
    }
  }

  // Der Nextcloud-Export der Sicherung steht seit #232 (V2) im Arbeitsvorrat des Kerns (server/src/lib/arbeitsvorrat.ts)

  // Vorstand: Registrierungen von Mitgliedern – je Antrag mit Zuordnungsvorschlag, prüfen und freigeben
  if (can(req, 'tco.registrierung:mitglied')) {
    const { registrierungenLesen } = await import('../platz/registrierung.js');
    for (const r of (await registrierungenLesen(db, 'OFFEN', 'MITGLIED')) as (Record<string, any> & { vorschlaege: { art: string; name: string; info: string; grund: string }[] })[]) {
      const v = r.vorschlaege.find((x) => x.art === 'MITGLIED');
      out.push({
        key: `REG_MITGLIED:${r.id}`, bereich: 'Vorstand', icon: 'add-employee', state: v ? 'Information' : 'Critical',
        titel: `Registrierung ${r.anzeigename} als Mitglied`,
        text: v ? `Vorschlag: ${v.name} – ${v.info} (${v.grund}). Prüfen und freigeben.` : 'Kein passendes Mitglied gefunden – bitte prüfen, zuordnen oder ablehnen.',
        datum: new Date(r.erstellt).toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10), pfad: `/tco/registrierungen?id=${r.id}`,
      });
    }
  }

  // Kassenwart: Mitgliedsanträge und Vertragswechsel (bestätigte Vertragsangebote) – je Antrag, warten auf Prüfung und Übernahme
  if (can(req, 'tco.antraege:edit')) {
    const rows = await db`
      select a.id, a.nummer, to_char(a.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, a.daten,
             coalesce((select (v.daten->>'vertragsaenderung')::boolean from tco.vertragsangebote v where v.nummer = a.daten->>'angebot_nr'), false) as wechsel
        from tco.mitgliedsantraege a where a.status = 'EINGANG' order by a.eingang`;
    for (const r of rows) {
      const pers = ((r.daten?.personen ?? []) as { vorname?: string; nachname?: string }[]).map((p) => `${p.vorname ?? ''} ${p.nachname ?? ''}`.trim()).filter(Boolean);
      const name = pers.length > 1 ? `${pers[0]} und ${pers.length - 1} weitere` : pers[0] ?? r.nummer;
      out.push({
        key: `MITGLIEDSANTRAG:${r.id}`, bereich: 'Kassenwart', icon: r.wechsel ? 'request' : 'personnel-view', state: 'Critical',
        titel: r.wechsel ? `Vertragswechsel ${name}` : `Mitgliedsantrag ${name}`,
        text: r.wechsel ? `${r.nummer} · Vertragsangebot bestätigt – prüfen und übernehmen (Verträge werden ergänzt).`
          : `${r.nummer} · online eingegangen – prüfen und übernehmen (Mitglied, Vertrag, SEPA-Mandat und Benutzer werden angelegt).`,
        datum: r.am, pfad: '/tco/mitgliedsantraege',
      });
    }
  }

  // Jugendwart: Schnuppertraining (#86) – jede neue Anmeldung wartet auf Kontaktaufnahme
  if (can(req, 'tco.schnupper:edit')) {
    const rows = await db`
      select s.adrnr, s.nummer, to_char(s.eingang at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, s.alter_jahre, s.stufe, s.mitteilung,
             coalesce(nullif(trim(concat_ws(' ', m.vorname, m.nachname)), ''), s.nummer) as name
        from tco.schnupper s left join tco.mitglieder m on m.adrnr = s.adrnr
       where s.status = 'NEU' order by s.eingang`;
    const STUFE: Record<string, string> = { NEU: 'neu im Tennis', ANFAENGER: 'Anfänger', FORTGESCHRITTEN: 'fortgeschritten' };
    for (const r of rows) {
      out.push({
        key: `SCHNUPPER:${r.adrnr}`, bereich: 'Jugendwart', icon: 'physical-activity', state: 'Critical',
        titel: `Anmeldung zum Schnuppertraining: ${r.name}`,
        text: [r.nummer, r.alter_jahre != null ? `${r.alter_jahre} Jahre` : '', STUFE[r.stufe] ?? '', r.mitteilung ? `„${String(r.mitteilung).slice(0, 120)}“` : '',
          'bitte Kontakt aufnehmen und einen Termin vereinbaren'].filter(Boolean).join(' · '),
        datum: r.am, pfad: '/tco/schnuppertraining',
      });
    }
  }

  // Hallenwart (#11): kommende Hallen-Einzelbuchungen (heute + 7 Tage) von Personen ohne Hallenschlüssel am Buchungstag – aufsperren
  if (can(req, 'tco.platzbuchung:verwalten')) {
    const rows = await db`
      select b.bid, b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis,
             coalesce(nullif(trim(u.display_name), ''), initcap(b.kunde)) as name
        from tco.bookings b
        join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
        left join core.users u on u.id = b.benutzer_id
       where b.status = '1' and b.benutzer_id is not null
         and b.datum between (now() at time zone 'Europe/Berlin')::date and (now() at time zone 'Europe/Berlin')::date + 7
         and not exists (select 1 from tco.schluessel s
                          where s.adrnr = ${db.unsafe(ADRNR_ZU_BENUTZER('b.benutzer_id'))} and s.ausgabe is not null and s.ausgabe <= b.datum
                            and (s.ruecknahme is null or s.ruecknahme > b.datum))
         and not exists (select 1 from tco.halle_geklaert g where g.bid = b.bid and g.datum = b.datum)
       order by b.datum, b.time_start`;
    for (const r of rows) {
      const [j, m, t] = [r.datum.slice(0, 4), r.datum.slice(5, 7), r.datum.slice(8, 10)];
      out.push({
        key: `HALLENWART:${r.bid}:${r.datum}`, bereich: 'Hallenwart', icon: 'locked', state: 'Information',
        titel: `Halle aufsperren: ${t}.${m}.${j} ${r.von}–${r.bis} Uhr`,
        text: `${r.name} hat keinen Hallenschlüssel – meldet sich bei ${HALLENWART.name}.`,
        datum: r.datum, pfad: can(req, 'tco.platz:admin') ? `/tco/platzverwaltung?tab=belegung&datum=${r.datum}` : `/tco/platz-buchen?datum=${r.datum}`,
        erledigen: { text: 'mit dem Kunden geklärt', url: '/dashboard/arbeitsvorrat/halle-geklaert', body: { bid: r.bid, datum: r.datum } },
      });
    }
  }

  // Kassenwart: heute über Einzelbuchungen erfasste Hallenbuchungen – darunter die einzelnen Buchungen mit Absprung in die Buchungsmaske
  if (can(req, 'tco.halle:display') || can(req, 'tco.platzbuchung:verwalten')) {
    const maske = can(req, 'tco.platz:admin') ? (d: string) => `/tco/platzverwaltung?tab=belegung&datum=${d}`
      : can(req, 'tco.platzbuchung:verwalten') ? (d: string) => `/tco/platz-buchen?datum=${d}` : () => '/tco/halle';
    const rows = await db`
      select b.bid, b.datum::text as datum, to_char(b.time_start, 'HH24:MI') as von, to_char(b.time_ende, 'HH24:MI') as bis,
             coalesce(nullif(trim(u.display_name), ''), initcap(b.kunde), '–') as name, b.preis::float8 as preis, coalesce(b.quelle, 'EP3') as quelle
        from tco.bookings b
        join tco.plaetze p on upper(trim(p.name)) = upper(trim(b.platz)) and p.art = 'HALLE'
        left join core.users u on u.id = b.benutzer_id
       where b.status = '1' and b.erstellt = (now() at time zone 'Europe/Berlin')::date
       order by b.datum, b.time_start`;
    if (rows.length) {
      const tm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
      const summe = rows.reduce((x, r) => x + Number(r.preis ?? 0), 0);
      out.push({
        key: 'HALLE_HEUTE', bereich: 'Kassenwart', icon: 'appointment-2', state: 'Information',
        titel: `Heute ${rows.length} Hallenbuchung${rows.length === 1 ? '' : 'en'} als Einzelbuchung erfasst`,
        text: `Neu angelegte Einzelbuchungen der Halle (Portal und EP3) mit Erfassungsdatum heute · ${eur(summe)} €`,
        datum: null, pfad: maske(rows[0].datum), betrag: summe,
        kinder: rows.map((r) => ({
          key: `HALLE_HEUTE:${r.bid}:${r.datum}`, bereich: 'Kassenwart', icon: 'appointment', state: 'Information' as const,
          titel: `${tm(r.datum)} ${r.von}–${r.bis} Uhr · ${r.name}`,
          text: `${r.preis != null ? `${eur(Number(r.preis))} €` : 'ohne Preis'} · ${r.quelle === 'PORTAL' ? 'Portal' : 'EP3'}`,
          datum: r.datum, pfad: maske(r.datum), betrag: Number(r.preis ?? 0),
        })),
      });
    }
  }

  // Kassenwart (#11): Abo-Bewerbung – bestätigte Abos und angenommene Angebote freigeben; Ausnahmen, wenn eine E-Mail nicht zugestellt werden konnte
  if (can(req, 'tco.platz:admin')) {
    const rows = await db`
      select w.id, w.art, w.name, w.status, w.wochentag, w.von, w.bis, w.mail_fehler, coalesce(p.name, '') as platz,
             to_char(coalesce(w.entschieden, w.angelegt) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am, s.name as saison
        from tco.abo_wunsch w join tco.abo_saison s on s.id = w.saison_id and s.aktiv left join tco.plaetze p on p.id = w.platz_id
       where w.status in ('BESTAETIGT', 'ANGENOMMEN') or (w.mail_fehler is not null and w.status in ('OFFEN', 'ANGEBOTEN'))
       order by w.wochentag, w.von, w.id`;
    const WT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const zeit = (r: Record<string, any>) => `${WT[r.wochentag]} ${hm(r.von)}–${hm(r.bis)} Uhr ${r.platz}`.trim();
    const pfad = '/tco/platz-buchen?ansicht=abo';
    const mails: Aufgabe[] = [];
    for (const r of rows) {
      if (r.mail_fehler && ['OFFEN', 'ANGEBOTEN'].includes(r.status)) {
        mails.push({
          key: `ABO_MAIL:${r.id}`, bereich: 'Kassenwart', icon: 'email', state: 'Negative',
          titel: `${r.name} nicht per E-Mail erreichbar`,
          text: `${zeit(r)} · ${r.status === 'OFFEN' ? 'Bestätigung des Abos steht aus' : 'Angebot aus der Warteliste wartet auf Annahme'} – ${r.mail_fehler}. Bitte persönlich ansprechen.`,
          datum: r.am, pfad,
          erledigen: { text: 'erledigt – nicht mehr anzeigen', url: '/platz/admin/abowunsch/mail-erledigt', body: { id: r.id } },
        });
      } else {
        out.push({
          key: `ABO_FREIGABE:${r.id}`, bereich: 'Kassenwart', icon: 'approvals', state: 'Critical',
          titel: `Hallenabo ${r.saison} freigeben: ${r.name}`,
          text: `${zeit(r)} · ${r.art === 'BESTAETIGUNG' ? 'vom bisherigen Abonnenten bestätigt' : 'Angebot aus der Warteliste angenommen'} – erst die Freigabe legt das Abo an.`,
          datum: r.am, pfad,
          erledigen: { text: 'freigeben', url: '/platz/admin/abowunsch/freigeben', body: { id: r.id } },
        });
      }
    }
    // Ausnahmen gesammelt: ein Eintrag mit den einzelnen darunter – einzeln oder alle auf einmal erledigen
    if (mails.length) {
      out.push({
        key: 'ABO_MAIL', bereich: 'Kassenwart', icon: 'email', state: 'Negative',
        titel: `Hallenabo ${rows[0].saison}: ${mails.length} Abonnent${mails.length === 1 ? '' : 'en'} bzw. Interessent${mails.length === 1 ? '' : 'en'} nicht per E-Mail erreichbar`,
        text: 'Keine E-Mail-Adresse gepflegt oder Versand gescheitert – bitte persönlich ansprechen. Erledigte Hinweise werden nicht mehr angezeigt.',
        datum: mails[0].datum, pfad, kinder: mails,
        erledigen: { text: 'alle erledigt – nicht mehr anzeigen', url: '/platz/admin/abowunsch/mail-erledigt', body: {} },
      });
    }
    // neue Bewerbungen um ein Hallenabo (Warteliste) – zur Kenntnis, je Bewerbung mit Position
    const warten = await db`
      select w.id, w.name, w.mitglied, w.wochentag, w.von, w.bis, coalesce(p.name, '') as platz, s.name as saison,
             to_char(w.angelegt at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am,
             (select count(*)::int from tco.abo_wunsch x where x.saison_id = w.saison_id and x.status = 'WARTET' and x.platz_id = w.platz_id and x.wochentag = w.wochentag
                 and x.von < w.bis and x.bis > w.von and (x.mitglied::int, -extract(epoch from x.angelegt), -x.id) > (w.mitglied::int, -extract(epoch from w.angelegt), -w.id)) + 1 as position
        from tco.abo_wunsch w join tco.abo_saison s on s.id = w.saison_id and s.aktiv left join tco.plaetze p on p.id = w.platz_id
       where w.status = 'WARTET' order by w.wochentag, w.von, w.id`;
    if (warten.length) {
      out.push({
        key: 'ABO_BEWERBUNG', bereich: 'Kassenwart', icon: 'waiver', state: 'Information',
        titel: `${warten.length} Bewerbung${warten.length === 1 ? '' : 'en'} um ein Hallenabo ${warten[0].saison}`,
        text: 'Warteliste – freie Stunden werden ab dem Nachrück-Termin angeboten; gebucht wird erst mit der Freigabe.',
        datum: warten.map((r) => r.am as string).sort().pop() ?? null, pfad,
        kinder: warten.map((r) => ({
          key: `ABO_BEWERBUNG:${r.id}`, bereich: 'Kassenwart', icon: 'waiver', state: 'Information' as const,
          titel: `${r.name}${r.mitglied ? '' : ' (kein Mitglied)'}: ${zeit(r)}`, text: `Position ${r.position} auf der Warteliste`, datum: r.am, pfad,
        })),
      });
    }
  }

  // Kassenwart: über den Dokumenten-Upload nach Paperless geladene Dokumente mit Folgeaktion „Überweisung an Einreicher“ –
  // als Gruppe mit den einzelnen Dokumenten darunter; einzeln oder alle als überwiesen kennzeichnen
  if (can(req, 'tco.fi:buchen')) {
    const rows = await db`
      select id, dok_id, titel, einreicher, to_char(am at time zone 'Europe/Berlin', 'YYYY-MM-DD') as am
        from tco.upload_folge where erledigt_am is null and folgeaktion ~* 'überweisung[[:space:]]+an[[:space:]]+einreicher' order by am, id`;
    if (rows.length) {
      const kinder: Aufgabe[] = rows.map((r) => ({
        key: `UPLOAD_UEBERWEISUNG:${r.id}`, bereich: 'Kassenwart', icon: 'money-bills', state: 'Critical' as const,
        titel: `Überweisung an ${r.einreicher}: ${r.titel}`,
        text: `Über den Dokumenten-Upload nach Paperless geladen${r.dok_id ? ` · Dokument ${r.dok_id}` : ' · wird in Paperless noch verarbeitet'} · Folgeaktion „Überweisung an Einreicher“.`,
        datum: r.am, pfad: '/tco/upload',
        erledigen: { text: 'überwiesen', url: '/dashboard/arbeitsvorrat/upload-erledigt', body: { id: r.id } },
        zahlung: { id: Number(r.id) },
      }));
      out.push({
        key: 'UPLOAD_UEBERWEISUNG', bereich: 'Kassenwart', icon: 'upload-to-cloud', state: 'Critical',
        titel: `${rows.length} neue${rows.length === 1 ? 's Dokument' : ' Dokumente'}: Überweisung an Einreicher`,
        text: 'Über die Uploadfunktion nach Paperless geladene Belege, die dem Einreicher zu erstatten sind.',
        datum: rows[0].am, pfad: '/tco/upload', kinder,
        erledigen: { text: 'alle überwiesen', url: '/dashboard/arbeitsvorrat/upload-erledigt', body: {} },
      });
    }
  }

  // Vorstand: Registrierungen externer Hallennutzer warten auf Bestätigung (nur ohne E-Mail-Bestätigung)
  if (can(req, 'tco.platz:admin')) {
    const [r] = await db`select count(*)::int as n, to_char(min(erstellt) at time zone 'Europe/Berlin', 'YYYY-MM-DD') as seit
                           from tco.registrierungen where status = 'OFFEN' and art = 'EXTERN'`;
    if (r?.n) {
      out.push({
        key: 'REGISTRIERUNG', bereich: 'Vorstand', icon: 'add-employee', state: 'Critical',
        titel: `${r.n} Registrierung${r.n === 1 ? '' : 'en'} zu bestätigen`,
        text: 'Neue Hallennutzer warten auf Freigabe in der Platzverwaltung.',
        datum: r.seit, pfad: '/tco/platzverwaltung',
      });
    }
  }
  // Kündigungen aus „Meine Mitgliedschaft“ (#232): Der Vorstand gibt frei, prüft die Kündigungsbestätigung und sendet sie
  if (can(req, 'tco.mitglieder:edit')) {
    const rows = await db`
      select k.id::int as id, k.status, k.adrnr, k.text, k.grund, k.eingang::text as eingang, k.benutzer, m.vorname, m.nachname
        from tco.kuendigungen k join tco.mitglieder m on m.adrnr = k.adrnr
       where k.status in ('OFFEN', 'FREIGEGEBEN') order by k.eingang, k.id`;
    for (const r of rows) {
      const name = `${r.vorname ?? ''} ${r.nachname ?? ''}`.trim() || r.benutzer;
      out.push({
        key: `KUENDIGUNG:${r.id}`, bereich: 'Vorstand', icon: 'decline', state: 'Critical',
        titel: r.status === 'OFFEN' ? `Kündigung freigeben: ${name}` : `Kündigungsbestätigung prüfen und senden: ${name}`,
        text: `${r.text}${r.grund ? ` Grund: ${r.grund}` : ''}`,
        datum: r.eingang, pfad: `/tco/mitglieder?adrnr=${r.adrnr}`, aktion: { art: 'KUENDIGUNG', id: r.id },
      });
    }
  }
  // Dokumenteneingang (#232, V1): Vorgänge, deren Ablage gescheitert ist oder die auf eine Prüfung warten
  if (can(req, 'tco.eingang:display')) {
    const [e] = await db`select count(*) filter (where status = 'fehler')::int as fehler, count(*) filter (where status = 'pruefen')::int as pruefen,
                                to_char(min(eingang_am) filter (where status = 'fehler') at time zone 'Europe/Berlin', 'YYYY-MM-DD') as fehler_seit,
                                to_char(min(eingang_am) filter (where status = 'pruefen') at time zone 'Europe/Berlin', 'YYYY-MM-DD') as pruefen_seit
                           from tco.eing_vorgaenge where status in ('fehler', 'pruefen')`;
    if (e?.fehler) {
      out.push({
        key: 'EINGANG_FEHLER', bereich: 'Dokumente', icon: 'inbox', state: 'Negative',
        titel: `Dokumenteneingang: ${e.fehler} ${e.fehler === 1 ? 'Vorgang' : 'Vorgänge'} mit Fehler`,
        text: 'Die Ablage ist gescheitert – in der Prüfliste nachsehen und erneut ablegen.',
        datum: e.fehler_seit, pfad: '/tco/dokumenteneingang',
      });
    }
    if (e?.pruefen) {
      out.push({
        key: 'EINGANG_PRUEFEN', bereich: 'Dokumente', icon: 'inbox', state: 'Critical',
        titel: `Dokumenteneingang: ${e.pruefen} ${e.pruefen === 1 ? 'Vorgang' : 'Vorgänge'} zu prüfen`,
        text: 'E-Mails und Anhänge warten in der Prüfliste auf Zuordnung und Ablage.',
        datum: e.pruefen_seit, pfad: '/tco/dokumenteneingang',
      });
    }
  }
  // gemeldete Ereignisse (#232, V1): Selbstbedienung der Mitglieder und Hallennutzer, Läufe, Störungen – bis „gesehen“
  out.push(...await hinweisAufgaben(req, 'tco'));
  return out;
}
