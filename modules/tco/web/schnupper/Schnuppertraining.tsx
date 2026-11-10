import { useEffect, useState, type ReactNode } from 'react';
import {
  Button, BusyIndicator, CheckBox, FlexBox, Input, Label, MessageStrip, Option, SegmentedButton, SegmentedButtonItem, Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { TCO } from '../util';

/**
 * Öffentliche Anmeldung zum Schnuppertraining /schnuppertraining (#86, ohne Anmeldung), angelehnt an den Mitgliedsantrag.
 * Die Person landet im Mitgliederstamm mit der Kategorie „Schnuppertraining“; ein Vereinstrainer meldet sich.
 */
interface Info {
  verein: string; einheiten: number; text: string; stufen: Record<string, string>; tage: string[]; zeiten: string[];
  alterMin: number; alterMax: number; volljaehrig: number;
}
const full = { width: '100%' };

function Feld({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.6rem', flex: 1, minWidth: '10rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

export function Schnuppertraining({ orgName, logo, onFertig }: OeffentlichProps) {
  const [info, setInfo] = useState<Info | null>(null);
  const [p, setP] = useState({ vorname: '', nachname: '', alter: '', gespielt: '' as '' | 'J' | 'N', stufe: '', email: '', mobil: '', erziehungsberechtigt: '', mitteilung: '', website: '' });
  const [tage, setTage] = useState<string[]>([]);
  const [zeiten, setZeiten] = useState<string[]>([]);
  const [termintext, setTermintext] = useState('');
  const [einwilligung, setEinwilligung] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  useEffect(() => { api.get<Info>(`${TCO}/schnupper`).then(setInfo).catch((e) => setError(e.message)); }, []);

  const alter = /^\d{1,2}$/.test(p.alter.trim()) ? Number(p.alter.trim()) : null;
  const minderjaehrig = alter != null && alter < (info?.volljaehrig ?? 18);
  const umschalten = (l: string[], x: string) => (l.includes(x) ? l.filter((y) => y !== x) : [...l, x]);
  const ok = !!(p.vorname.trim() && p.nachname.trim() && alter != null && p.gespielt && p.stufe && (p.email.trim() || p.mobil.trim())
    && (tage.length || termintext.trim()) && (!minderjaehrig || p.erziehungsberechtigt.trim()) && einwilligung);

  async function absenden() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(`${TCO}/schnupper`, {
        vorname: p.vorname, nachname: p.nachname, alter, gespielt: p.gespielt === 'J', stufe: p.stufe,
        email: p.email.trim() || null, mobil: p.mobil.trim() || null,
        termine: { tage, zeiten, text: termintext.trim() || null },
        erziehungsberechtigt: minderjaehrig ? p.erziehungsberechtigt : null, mitteilung: p.mitteilung.trim() || null,
        einwilligung, website: p.website,
      });
      setFertig(r.text);
      window.scrollTo(0, 0);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (fertig) {
    return (
      <CenterCard title={orgName} subtitle="Schnuppertraining" logo={logo}>
        <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
        <Button design="Emphasized" style={full} onClick={onFertig}>Zum Portal</Button>
      </CenterCard>
    );
  }
  return (
    <CenterCard title={orgName} subtitle="Anmeldung Schnuppertraining" logo={logo} breit>
      {!info ? <BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /> : (
        <form onSubmit={(e) => { e.preventDefault(); if (ok) absenden(); }}>
          <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '0.75rem' }}>{info.text}</MessageStrip>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}

          <Title level="H5" style={{ margin: '0.5rem 0' }}>Wer möchte schnuppern?</Title>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="Vorname" required><Input style={full} value={p.vorname} onInput={(e) => setP({ ...p, vorname: e.target.value })} /></Feld>
            <Feld label="Nachname" required><Input style={full} value={p.nachname} onInput={(e) => setP({ ...p, nachname: e.target.value })} /></Feld>
          </FlexBox>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="Alter (Jahre)" required>
              <Input style={full} type="Number" value={p.alter} onInput={(e) => setP({ ...p, alter: e.target.value })}
                     valueState={p.alter && (alter == null || alter < info.alterMin || alter > info.alterMax) ? 'Negative' : 'None'} />
            </Feld>
            <Feld label="Schon Tennis gespielt?" required>
              <SegmentedButton style={full} onSelectionChange={(e) => setP({ ...p, gespielt: ((e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.g ?? '') as '' | 'J' | 'N' })}>
                <SegmentedButtonItem data-g="J" selected={p.gespielt === 'J'}>Ja</SegmentedButtonItem>
                <SegmentedButtonItem data-g="N" selected={p.gespielt === 'N'}>Nein</SegmentedButtonItem>
              </SegmentedButton>
            </Feld>
            <Feld label="Spielstärke" required>
              <Select style={full} onChange={(e) => setP({ ...p, stufe: (e.detail.selectedOption as HTMLElement).dataset.s ?? '' })}>
                <Option data-s="" selected={!p.stufe}>bitte wählen</Option>
                {Object.entries(info.stufen).map(([k, t]) => <Option key={k} data-s={k} selected={p.stufe === k}>{t}</Option>)}
              </Select>
            </Feld>
          </FlexBox>
          {minderjaehrig && (
            <Feld label="Erziehungsberechtigte/r (Ansprechpartner für den Trainer)" required>
              <Input style={full} value={p.erziehungsberechtigt} onInput={(e) => setP({ ...p, erziehungsberechtigt: e.target.value })} />
            </Feld>
          )}

          <Title level="H5" style={{ margin: '0.5rem 0' }}>Kontakt</Title>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.4rem' }}>Bitte mindestens E-Mail oder Handynummer angeben.</Text>
          <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Feld label="E-Mail"><Input style={full} type="Email" value={p.email} onInput={(e) => setP({ ...p, email: e.target.value })} /></Feld>
            <Feld label="Handynummer"><Input style={full} type="Tel" value={p.mobil} onInput={(e) => setP({ ...p, mobil: e.target.value })} /></Feld>
          </FlexBox>

          <Title level="H5" style={{ margin: '0.5rem 0' }}>Mögliche Termine</Title>
          <Feld label="Wochentage" required>
            <FlexBox style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
              {info.tage.map((x) => <Button key={x} design={tage.includes(x) ? 'Emphasized' : 'Default'} onClick={() => setTage(umschalten(tage, x))}>{x}</Button>)}
            </FlexBox>
          </Feld>
          <Feld label="Tageszeit">
            <FlexBox style={{ gap: '0.25rem', flexWrap: 'wrap' }}>
              {info.zeiten.map((x) => <Button key={x} design={zeiten.includes(x) ? 'Emphasized' : 'Default'} onClick={() => setZeiten(umschalten(zeiten, x))}>{x}</Button>)}
            </FlexBox>
          </Feld>
          <Feld label="Weitere Hinweise zu Terminen (optional)">
            <Input style={full} value={termintext} placeholder="z. B. ab 17 Uhr, nicht in den Ferien" maxlength={500} onInput={(e) => setTermintext(e.target.value)} />
          </Feld>
          <Feld label="Mitteilung an den Trainer (optional)"><TextArea rows={2} value={p.mitteilung} maxlength={1000} onInput={(e) => setP({ ...p, mitteilung: e.target.value })} /></Feld>

          <CheckBox wrappingType="Normal" checked={einwilligung} onChange={(e) => setEinwilligung(e.target.checked)} style={{ marginLeft: '-0.5rem' }}
                    text={`Ich bin einverstanden, dass der ${info.verein} meine Angaben speichert und mich zur Abstimmung des Schnuppertrainings kontaktiert. Die Kontaktdaten werden nur dafür genutzt. *`} />
          {/* Honigtopf: für Menschen unsichtbar */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={p.website} onChange={(e) => setP({ ...p, website: e.target.value })}
                 style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} aria-hidden />
          <Button design="Emphasized" style={{ ...full, marginTop: '0.5rem' }} onClick={absenden} loading={busy} disabled={!ok}>Zum Schnuppertraining anmelden</Button>
          <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
            * Pflichtangaben. {info.einheiten} Einheiten sind kostenlos; danach kannst du einer Trainingsgruppe beitreten.
          </Text>
        </form>
      )}
    </CenterCard>
  );
}
