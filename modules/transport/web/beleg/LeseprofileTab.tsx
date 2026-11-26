import { useEffect, useState } from 'react';
import { Button, Input, Label, MessageStrip, Switch, Text } from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { AuswahlBox } from '@core/components/AuswahlBox';
import { Section } from '@core/components/Section';
import { useCan, useFunktion } from '@core/session';
import { toast } from '@core/toast';
import { T, type AdrDD } from '../util';
import { F_LESEPROFILE, R_LESEPROFILE, profilSpeichern, profileLaden } from './api';
import type { BelegLayout, BelegProfil } from './typen';

/**
 * Administration → Einstellungen → Euroflex → Leseprofile (Auftrag aus Beleg): je Layout, das die Erkennung kennt, die Bezeichnung
 * (steht in der Maske hinter „Aus Beleg vorbefüllt“), ob es verwendet wird, und der bevorzugte Kunde.
 * GET /beleg/profile, PUT /beleg/profile/:layout – Recht transport.leseprofile:edit, Funktion transport.beleg.profile.
 * Doku: docs/euroflex-belegerfassung.md.
 */
const LAYOUT_TEXT: Record<BelegLayout, string> = {
  bestellung: 'Bestellung (Formular mit Bestellnummer, Liefer- und Ladeanschrift)',
  ladeauftrag: 'Ladeauftrag (Formular mit Lade- und Entladestelle)',
  allgemein: 'Allgemein (liest über Schlagworte – Rückfall, wenn kein anderes Layout passt)',
};
const gleich = (a: BelegProfil, b: BelegProfil) => a.bezeichnung.trim() === b.bezeichnung.trim() && a.aktiv === b.aktiv && a.kunde === b.kunde;

export function LeseprofileTab() {
  const can = useCan();
  const funktion = useFunktion();
  const darf = can(R_LESEPROFILE) && funktion(F_LESEPROFILE);
  /** gespeicherter Stand und Bearbeitung je Layout */
  const [basis, setBasis] = useState<BelegProfil[] | null>(null);
  const [profile, setProfile] = useState<BelegProfil[]>([]);
  const [adrDD, setAdrDD] = useState<AdrDD[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BelegLayout | null>(null);

  useEffect(() => {
    if (!darf) return;
    profileLaden().then((p) => { const l = Array.isArray(p) ? p : []; setBasis(l); setProfile(l); }).catch((e) => setError((e as Error).message));
    // Kontakte für die Auswahl; ohne Recht auf Aufträge bleibt nur der Name des gespeicherten Kunden
    api.get<AdrDD[]>(`${T}/adressen`).then(setAdrDD).catch(() => setAdrDD([]));
  }, [darf]);

  if (!darf) {
    return <MessageStrip hideCloseButton design="Information">Die Funktion „Leseprofile“ ist abgeschaltet (Administration → Einstellungen → Funktionen) oder das Recht dazu fehlt.</MessageStrip>;
  }
  const aendern = (layout: BelegLayout, x: Partial<BelegProfil>) => setProfile((l) => l.map((p) => (p.layout === layout ? { ...p, ...x } : p)));

  async function speichern(p: BelegProfil) {
    setBusy(p.layout); setError(null);
    try {
      await profilSpeichern(p);
      const neu = { ...p, bezeichnung: p.bezeichnung.trim(), kunde_name: p.kunde ? adrDD.find((d) => d.key === String(p.kunde))?.text ?? p.kunde_name : null };
      setBasis((l) => (l ?? []).map((x) => (x.layout === p.layout ? neu : x)));
      setProfile((l) => l.map((x) => (x.layout === p.layout ? neu : x)));
      toast(`Leseprofil „${neu.bezeichnung}“ gesichert`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <>
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Section title="Leseprofile (Auftrag aus Beleg)">
        <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
          „Auftrag aus Beleg“ liest den Frachtauftrag eines Kunden (PDF oder Bild) und füllt die Erfassungsmaske vor. Je Layout, das die Erkennung
          kennt, gibt es ein Leseprofil. Ein abgeschaltetes Profil wird nicht verwendet. Übernommen wird immer nur, was eindeutig zu lesen ist –
          bei mehreren Möglichkeiten fragt die Maske nach.
        </Text>
        {!basis && !error && <Text className="portal-muted">Lade Leseprofile …</Text>}
        {basis && !basis.length && <Text className="portal-muted">Es sind keine Leseprofile vorhanden.</Text>}
        {basis && basis.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(12rem, 1.2fr) minmax(10rem, 1fr) max-content minmax(14rem, 1.2fr) max-content', gap: '0.5rem 1.25rem', alignItems: 'center', minWidth: '56rem' }}>
              <Label>Layout</Label><Label>Bezeichnung</Label><Label>Aktiv</Label><Label>Bevorzugter Kunde</Label><span />
              {profile.map((p) => {
                const alt = basis.find((x) => x.layout === p.layout) ?? p;
                const name = p.bezeichnung.trim();
                return [
                  <Text key={`${p.layout}l`}>{LAYOUT_TEXT[p.layout] ?? p.layout}</Text>,
                  <Input key={`${p.layout}b`} style={{ width: '100%' }} maxlength={60} value={p.bezeichnung} data-kein-autofill accessibleName={`Bezeichnung ${p.layout}`}
                         valueState={name ? 'None' : 'Negative'} onInput={(e) => aendern(p.layout, { bezeichnung: e.target.value })} />,
                  <Switch key={`${p.layout}a`} textOn="Ja" textOff="Nein" checked={p.aktiv} accessibleName={`Leseprofil ${p.layout} aktiv`}
                          onChange={(e) => aendern(p.layout, { aktiv: e.target.checked })} />,
                  <AuswahlBox key={`${p.layout}k`} style={{ width: '100%' }} wert={p.kunde ? String(p.kunde) : ''} placeholder="Name oder Ort eingeben (leer = keiner)" max={50}
                              eintraege={adrDD.length ? adrDD : p.kunde ? [{ key: String(p.kunde), text: p.kunde_name ?? `Kontakt ${p.kunde}` }] : []}
                              onWaehle={(k) => aendern(p.layout, { kunde: k ? Number(k) : null })} />,
                  <Button key={`${p.layout}s`} design="Emphasized" icon="save" disabled={!name || gleich(p, alt) || busy !== null} loading={busy === p.layout}
                          onClick={() => { void speichern(p); }}>Sichern</Button>,
                ];
              })}
            </div>
          </div>
        )}
        <MessageStrip hideCloseButton design="Information" style={{ marginTop: '0.75rem' }}>
          Der bevorzugte Kunde wird gewählt, wenn der Beleg mehrere passende Kontakte ergibt und er darunter ist.
        </MessageStrip>
      </Section>
    </>
  );
}
