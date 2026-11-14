import { useEffect, useState } from 'react';
import { BusyIndicator, Link, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { einstellungLink } from '@core/einstellungen';
import { useCan } from '@core/session';
import { TCO } from '../util';

/**
 * Kapitel „Kontenfindung“ (#232, E4): Welches FI-Konto bebucht welcher Vorgang? Die Angaben standen verstreut in fünf
 * Kapiteln – hier stehen sie in einer Liste. Gepflegt wird jede Angabe weiter an ihrer einen Stelle (Spalte „Pflege“
 * springt dorthin); das Kapitel selbst speichert nichts. Man sieht die Zeilen, deren Quelle man lesen darf.
 */
interface Zeile { vorgang: string; konto: string; wo: string; ziel: string }
interface Quelle { recht: string; laden: () => Promise<Zeile[]> }

const zu = {
  finanzen: einstellungLink('tco', 'finanzen'),
  beitrag: einstellungLink('tco', 'beitragseinzug'),
  clubhaus: einstellungLink('tco', 'clubhaus'),
  verzehr: einstellungLink('tco', 'verzehr'),
  schluessel: einstellungLink('tco', 'hallenschluessel'),
};

const QUELLEN: Quelle[] = [
  {
    recht: 'tco.stammdaten:edit',
    laden: async () => {
      const v = await api.get<{ fi_bankkonten?: string | null; fi_manuell_konten?: string | null }>(`${TCO}/verein`);
      return [
        { vorgang: 'Bankimport (Konten mit Bankdatei)', konto: v.fi_bankkonten ?? '', wo: 'Finanzen', ziel: zu.finanzen },
        { vorgang: 'Kasse und Konten ohne Bankdatei (manuelle Buchung)', konto: v.fi_manuell_konten ?? '', wo: 'Finanzen', ziel: zu.finanzen },
      ];
    },
  },
  {
    recht: 'tco.soll:glaeubiger',
    laden: async () => {
      const r = await api.get<{ cfg: { bankkonto: string } }>(`${TCO}/soll/cfg`);
      return [{ vorgang: 'Lastschrift: Bankkonto', konto: r.cfg.bankkonto, wo: 'Beitragseinzug', ziel: zu.beitrag }];
    },
  },
  {
    recht: 'tco.clubhaus:display',
    laden: async () => {
      const r = await api.get<{ cfg: { konto_einnahmen: string; konto_ware: string } }>(`${TCO}/clubhaus/init?jahr=${new Date().getFullYear()}`);
      return [
        { vorgang: 'Clubhaus: Einzahlungen', konto: r.cfg.konto_einnahmen, wo: 'Clubhaus', ziel: zu.clubhaus },
        { vorgang: 'Clubhaus: Getränke-Wareneingang', konto: r.cfg.konto_ware, wo: 'Clubhaus', ziel: zu.clubhaus },
      ];
    },
  },
  {
    recht: 'tco.verzehr:display',
    laden: async () => {
      const c = await api.get<{ erloeskonto: string; forderungskonto: string }>(`${TCO}/verzehr/cfg`);
      return [
        { vorgang: 'Verzehr: Erlös', konto: c.erloeskonto, wo: 'Verzehr', ziel: zu.verzehr },
        { vorgang: 'Verzehr: Forderung', konto: c.forderungskonto, wo: 'Verzehr', ziel: zu.verzehr },
      ];
    },
  },
  {
    recht: 'tco.schluessel:admin',
    laden: async () => {
      const c = await api.get<{ kassenkonto: string; pfand?: { kontoAusgabe?: string; kontoRueckgabe?: string } }>(`${TCO}/schluessel/einstellungen/daten`);
      return [
        { vorgang: 'Hallenschlüssel: Kasse', konto: c.kassenkonto, wo: 'Hallenschlüssel', ziel: zu.schluessel },
        ...(c.pfand?.kontoAusgabe ? [{ vorgang: 'Hallenschlüssel: Pfand bei Ausgabe', konto: c.pfand.kontoAusgabe, wo: 'Hallenschlüssel', ziel: zu.schluessel }] : []),
        ...(c.pfand?.kontoRueckgabe ? [{ vorgang: 'Hallenschlüssel: Pfand bei Rückgabe', konto: c.pfand.kontoRueckgabe, wo: 'Hallenschlüssel', ziel: zu.schluessel }] : []),
      ];
    },
  },
];

const zelle = { padding: '0.4rem 0.75rem', textAlign: 'left' as const, verticalAlign: 'top' as const };

export function Kontenfindung() {
  const can = useCan();
  const [zeilen, setZeilen] = useState<Zeile[] | null>(null);
  const [fehler, setFehler] = useState<string[]>([]);
  useEffect(() => {
    let aktiv = true;
    Promise.all(QUELLEN.filter((q) => can(q.recht)).map((q) => q.laden().catch((e) => { setFehler((f) => [...f, (e as Error).message]); return [] as Zeile[]; })))
      .then((l) => { if (aktiv) setZeilen(l.flat()); });
    return () => { aktiv = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!zeilen) return <BusyIndicator active style={{ display: 'block', padding: '2rem 0' }} />;
  return (
    <>
      <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
        Welcher Vorgang bebucht welches Konto der FI-Belege. Geändert wird jede Angabe an ihrer Stelle – die Spalte „Pflege“ führt dorthin.
        Das Erlöskonto je Produkt steht in <Link onClick={() => { window.location.assign('/tco/produkte?sicht=alle'); }}>Produkte und Preise</Link>.
      </Text>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: '56rem' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
            <th style={zelle}>Vorgang</th><th style={zelle}>Konto</th><th style={zelle}>Pflege</th>
          </tr></thead>
          <tbody>
            {zeilen.map((z) => (
              <tr key={z.vorgang} style={{ borderBottom: '1px solid var(--sapList_BorderColor)' }}>
                <td style={zelle}>{z.vorgang}</td>
                <td style={zelle}>{z.konto || <span className="portal-muted">nicht hinterlegt</span>}</td>
                <td style={zelle}><Link onClick={() => { window.location.assign(z.ziel); }}>{z.wo}</Link></td>
              </tr>
            ))}
            {!zeilen.length && <tr><td style={zelle} colSpan={3}><span className="portal-muted">Keine Angaben, die du lesen darfst.</span></td></tr>}
          </tbody>
        </table>
      </div>
      {fehler.length > 0 && <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>Nicht geladen: {[...new Set(fehler)].join(' · ')}</Text>}
    </>
  );
}
