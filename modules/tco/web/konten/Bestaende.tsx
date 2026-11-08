import { useEffect, useState } from 'react';
import { BusyIndicator, Button, Input, Label, MessageStrip, ObjectStatus, Option, Select, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { Section } from '@core/components/Section';
import { toast } from '@core/toast';
import { betrag, eur } from '../util';
import { KO, type Bestand } from './typen';

/**
 * Jahresanfangs- und Endbestände der Bank-, Kassen- und Kreditkonten (tco.fibankab).
 * Ergänzung gegenüber der SAP-App: die Werte sind die Basis der Saldenrechnung in FI Belege
 * und Einnahmen & Ausgaben (Anfangsbestand → sonst Endbestand Vorjahr → sonst fortgeschrieben).
 */

const zelle = { padding: '0.25rem 0.5rem', verticalAlign: 'middle' } as const;
const kopf = { ...zelle, textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--sapList_BorderColor)' } as const;
const rechts = { ...kopf, textAlign: 'right' } as const;

/** „1.234,56“ → 1234.56; leer → null */
const zahl = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
};
const text = (v: number | null) => (v === null ? '' : betrag(v));

interface Zeile extends Bestand { ab: string; eb: string }

export function Bestaende({ edit, jahre, aktJahr }: { edit: boolean; jahre: number[]; aktJahr: number }) {
  const [jahr, setJahr] = useState(jahre.includes(aktJahr) ? aktJahr : jahre[jahre.length - 1]);
  const [zeilen, setZeilen] = useState<Zeile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function laden(j = jahr) {
    setBusy(true);
    try {
      const r = await api.get<{ zeilen: Bestand[] }>(`${KO}/bestaende?jahr=${j}`);
      setZeilen(r.zeilen.map((z) => ({ ...z, ab: text(z.anfangsbestand), eb: text(z.endbestand) })));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { laden(jahr); }, [jahr]); // eslint-disable-line react-hooks/exhaustive-deps

  const setZ = (konto: string, patch: Partial<Zeile>) => setZeilen((l) => (l ?? []).map((z) => (z.konto === konto ? { ...z, ...patch } : z)));

  async function speichern(z: Zeile) {
    const ab = zahl(z.ab), eb = zahl(z.eb);
    if (Number.isNaN(ab) || Number.isNaN(eb)) { setError(`Konto ${z.konto}: bitte Beträge als Zahl eingeben (z. B. 1.234,56).`); return; }
    setError(null);
    setBusy(true);
    try {
      const r = await api.put<{ text: string }>(`${KO}/bestand`, { jahr, konto: z.konto, anfangsbestand: ab, endbestand: eb });
      toast(r.text, 4000);
      await laden();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const geaendert = (z: Zeile) => zahl(z.ab) !== z.anfangsbestand || zahl(z.eb) !== z.endbestand;

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '0.5rem' }}>{error}</MessageStrip>}
      <Section title={`Bestände Geldkonten ${jahr}`} count={zeilen?.length ?? 0} flush
               actions={<>
                 <Label>Geschäftsjahr</Label>
                 <Select style={{ width: '7rem' }} onChange={(e) => setJahr(Number((e.detail.selectedOption as HTMLElement).dataset.j))}>
                   {jahre.map((j) => <Option key={j} data-j={j} selected={j === jahr}>{j}</Option>)}
                 </Select>
               </>}>
        <BusyIndicator active={busy} delay={300} style={{ width: '100%', display: 'block' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={kopf}><Label>Konto</Label></th>
                  <th style={{ ...kopf, minWidth: '12rem' }}><Label>Bezeichnung</Label></th>
                  <th style={kopf}><Label>Kz.</Label></th>
                  <th style={rechts}><Label>Anfangsbestand 01.01.</Label></th>
                  <th style={rechts}><Label>Endbestand 31.12.</Label></th>
                  <th style={kopf}><Label>Anfangsbestand der Saldenrechnung</Label></th>
                  <th style={rechts}><Label>Kontostand 31.12. (Buchungen)</Label></th>
                  <th style={rechts}><Label>Differenz Endbestand</Label></th>
                  <th style={kopf} />
                </tr>
              </thead>
              <tbody>
                {(zeilen ?? []).map((z) => (
                  <tr key={z.konto} style={{ borderTop: '1px solid var(--sapList_BorderColor)' }}>
                    <td style={zelle}><Text style={{ fontWeight: 'bold' }}>{z.konto}</Text></td>
                    <td style={zelle}><Text>{z.name}</Text></td>
                    <td style={zelle}><Text>{z.kennzahl}</Text></td>
                    <td style={{ ...zelle, textAlign: 'right' }}>
                      <Input style={{ width: '8rem', textAlign: 'right' }} placeholder="nicht gepflegt" value={z.ab} readonly={!edit} onChange={(e) => setZ(z.konto, { ab: e.target.value })} />
                    </td>
                    <td style={{ ...zelle, textAlign: 'right' }}>
                      <Input style={{ width: '8rem', textAlign: 'right' }} placeholder="nicht gepflegt" value={z.eb} readonly={!edit} onChange={(e) => setZ(z.konto, { eb: e.target.value })} />
                    </td>
                    <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                      <Text>{eur(z.rechnerisch)}</Text> <span className="portal-muted portal-small">({z.quelle})</span>
                    </td>
                    <td style={{ ...zelle, textAlign: 'right', whiteSpace: 'nowrap' }}><Text>{eur(z.kontostand)}</Text></td>
                    <td style={{ ...zelle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {z.differenz === null ? <span className="portal-muted">–</span>
                        : <ObjectStatus state={Math.abs(z.differenz) < 0.005 ? 'Positive' : 'Negative'}>{eur(z.differenz)}</ObjectStatus>}
                    </td>
                    <td style={{ ...zelle, whiteSpace: 'nowrap' }}>
                      {edit && <Button icon="save" design="Transparent" disabled={busy || !geaendert(z)} onClick={() => speichern(z)}>Speichern</Button>}
                    </td>
                  </tr>
                ))}
                {zeilen && !zeilen.length && <tr><td colSpan={9} className="portal-empty">Keine Bank-, Kassen- oder Kreditkonten (Kennzahl BA/BK) vorhanden</td></tr>}
              </tbody>
            </table>
          </div>
        </BusyIndicator>
      </Section>
      <MessageStrip hideCloseButton style={{ marginTop: '0.5rem' }}>
        Der Anfangsbestand eines Jahres gilt für Kontoauszug, Tagessaldo und Einnahmen & Ausgaben. Ohne gepflegten Anfangsbestand wird der
        Endbestand des Vorjahres verwendet, sonst der jüngste gepflegte Anfangsbestand mit allen Buchungen fortgeschrieben. Leere Felder löschen den Wert.
      </MessageStrip>
    </>
  );
}
