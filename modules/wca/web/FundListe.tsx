import { useMemo, useState } from 'react';
import { Button, Text } from '@ui5/webcomponents-react';
import { Section } from '@core/components/Section';
import type { AuswEintrag, Fund, Kategorie } from '../server/typen';
import { tageVon, zeilen as zeilenBilden, type Sicht, type Zeile } from './ansicht';
import { dat, kopieren, type Spalte, stufeText, StufeStatus, Tabelle, tm, tsv, zahl } from './util';

/** Zeitspanne einer Gruppe: „Mo 16.11.“ bzw. „16.11.–19.11. (3 Tage)“ */
export function tageText(tage: string[]): string {
  if (!tage.length) return '';
  if (tage.length === 1) return tm(tage[0]);
  return `${tm(tage[0])}–${tm(tage[tage.length - 1])} (${tage.length} Tage)`;
}

/** Knopf „Freigeben“ an einem Fund: der Text gilt danach für diese Regel und diesen Account als in Ordnung */
export function FreigabeKnopf({ sicht, e, x }: { sicht: Sicht; e: AuswEintrag | null; x: Fund }) {
  if (!sicht.freigeben || !e || !x.freigebbar) return null;
  return (
    <Button design="Transparent" icon="accept" className="portal-wca-freigabe"
            tooltip={`Text für ${x.regel} auf diesem Account freigeben – wird danach nicht mehr bemängelt`}
            onClick={() => sicht.freigeben!(e, x)}>Freigeben</Button>
  );
}

/**
 * Fundliste eines Reiters (Kontierung: K+P, Texte: T+R): eine Zeile je Rückmeldung bzw. Personentag mit allen Fehlern ab der Stufe,
 * Chips je Regel zum Eingrenzen, Export als TSV.
 */
export function FundListe({ sicht, kategorien, titel }: { sicht: Sicht; kategorien: Kategorie[]; titel: string }) {
  const { a, f } = sicht;
  const [regel, setRegel] = useState<string | null>(null);
  const alle = useMemo(() => zeilenBilden(sicht.gruppen, kategorien, f.stufe), [sicht.gruppen, kategorien, f.stufe]);
  const regelName = useMemo(() => new Map(a.regeln.map((r) => [r.id, r.name])), [a.regeln]);

  const chips = useMemo(() => {
    const m = new Map<string, number>();
    for (const z of alle) for (const x of z.funde) m.set(x.regel, (m.get(x.regel) ?? 0) + 1);
    return [...m].sort(([x], [y]) => x.localeCompare(y, 'de', { numeric: true }));
  }, [alle]);
  const liste = regel ? alle.filter((z) => z.funde.some((x) => x.regel === regel)) : alle;
  const einzel = liste.reduce((s, z) => s + z.funde.length, 0);

  const eintrag = (z: Zeile) => (z.eintrag === null ? null : a.eintraege[z.eintrag]);
  const spalten: Spalte<Zeile>[] = [
    { titel: 'Stufe', fest: true, wert: (z) => <StufeStatus stufe={z.stufe} />, sort: (z) => z.stufe * 10000 + z.stunden },
    {
      titel: 'Fehler', wert: (z) => (
        <div className="portal-wca-funde">{z.funde.map((x, i) => <div key={i} title={x.tipp}>• <b>{x.regel}</b> {regelName.get(x.regel) ?? ''}</div>)}</div>
      ), sort: (z) => z.funde.length,
    },
    { titel: 'Person', wert: (z) => <><div>{z.person}</div><div className="portal-muted portal-small">{z.team}</div></>, sort: (z) => z.person },
    { titel: 'Tag', fest: true, wert: (z) => tageText(tageVon(a, z)), sort: (z) => tageVon(a, z)[0] ?? '' },
    {
      titel: 'Account', wert: (z) => {
        const e = eintrag(z);
        if (!e) return <span className="portal-muted">Personentag</span>;
        return (
          <>
            <div>{e.accName}{e.accKey ? <span className="portal-muted"> ({e.accKey})</span> : null}</div>
            <div className="portal-muted portal-small">{[e.kunde, e.ber, e.key].filter(Boolean).join(' · ')}</div>
          </>
        );
      }, sort: (z) => eintrag(z)?.accName ?? '',
    },
    { titel: 'h', rechts: true, wert: (z) => zahl(z.stunden), sort: (z) => z.stunden, summe: (zs) => zahl(zs.reduce((s, z) => s + z.stunden, 0)) },
    {
      titel: 'Text und Hinweise', breit: true, wert: (z) => {
        const e = eintrag(z);
        return (
          <>
            {e && <div>{e.text ? `„${e.text}“` : <span className="portal-muted">(kein Text)</span>}</div>}
            {z.funde.map((x, i) => <div key={i} className="portal-muted portal-small">{x.meldung} <FreigabeKnopf sicht={sicht} e={e} x={x} /></div>)}
          </>
        );
      },
    },
  ];

  function exportieren() {
    const text = tsv(
      ['Stufe', 'Anzahl Fehler', 'Fehler', 'Team', 'Person', 'Von', 'Bis', 'Tage', 'Account', 'Kunde', 'Bereich', 'Ticket', 'Stunden', 'Text', 'Hinweise'],
      liste.map((z) => {
        const e = eintrag(z);
        const t = tageVon(a, z);
        return [stufeText(z.stufe), z.funde.length, z.funde.map((x) => x.regel).join(', '), z.team, z.person, dat(t[0]), dat(t[t.length - 1]), t.length,
          e?.accName ?? '', e?.kunde ?? '', e?.ber ?? '', e?.key ?? '', z.stunden, e?.text ?? '', z.funde.map((x) => x.meldung).join(' | ')];
      }),
    );
    kopieren(text, `${liste.length} Zeilen als Tabelle kopiert`);
  }

  return (
    <Section title={titel} count={liste.length} flush
             actions={<Button icon="copy" disabled={!liste.length} onClick={exportieren}>Als Tabelle kopieren</Button>}>
      <div className="portal-wca-chips">
        <Text className="portal-muted">
          {liste.length} fehlerhafte Rückmeldungen bzw. Personentage mit zusammen {einzel} Einzelfehlern ab Stufe {stufeText(f.stufe)}
          {a.freigegeben ? ` · ${a.freigegeben} freigegebene Funde ausgeblendet (Prüfregeln → Freigegebene Texte)` : ''}
        </Text>
        <div className="portal-row">
          <Button design={regel === null ? 'Emphasized' : 'Default'} onClick={() => setRegel(null)}>Alle ({alle.length})</Button>
          {chips.map(([id, n]) => (
            <Button key={id} design={regel === id ? 'Emphasized' : 'Default'} tooltip={regelName.get(id)} onClick={() => setRegel(regel === id ? null : id)}>{id} ({n})</Button>
          ))}
        </div>
      </div>
      <Tabelle<Zeile> spalten={spalten} zeilen={liste} schluessel={(z) => z.id} max={150} sortierung={{ titel: 'Stufe', ab: true }}
                      leer={`Keine Funde ab Stufe ${stufeText(f.stufe)}`} />
    </Section>
  );
}
