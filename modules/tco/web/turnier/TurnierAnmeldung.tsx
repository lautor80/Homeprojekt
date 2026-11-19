import { useEffect, useState, type ReactNode } from 'react';
import {
  Button, BusyIndicator, CheckBox, FlexBox, Input, Label, Link, MessageStrip, Option, Select, Text, TextArea, Title,
} from '@ui5/webcomponents-react';
import { api } from '@core/api';
import { CenterCard } from '@core/pages/AuthPages';
import type { OeffentlichProps } from '@core/platform';
import { dat } from '../util';
import { STATUS_TEXT, TO, type LiveDaten } from './api';

/**
 * Öffentliche Turnier-Anmeldung /turnier?t=<kennung> (ohne Anmeldung am Portal). Nach dem Absenden gibt es den
 * persönlichen Link (Spiele, Ergebnisse eintragen, abmelden); ist das Feld voll, landet die Meldung auf der Warteliste.
 */
interface Info { turnier: LiveDaten['turnier']; gemeldet: number; frei: number | null; offen: boolean }
const full = { width: '100%' };

function Feld({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.6rem', flex: 1, minWidth: '10rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

const jahr = new Date().getFullYear();

export function TurnierAnmeldung({ orgName, logo }: OeffentlichProps) {
  const [kennung] = useState(() => new URLSearchParams(window.location.search).get('t') ?? '');
  const [info, setInfo] = useState<Info | null>(null);
  const [p, setP] = useState({ vorname: '', nachname: '', geburtsjahr: '', geschlecht: '', lk: '', email: '', telefon: '', bemerkung: '', website: '' });
  const [einwilligung, setEinwilligung] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<{ text: string; link?: string; status: string } | null>(null);

  useEffect(() => {
    if (!kennung) { setLadefehler('Der Link ist unvollständig – es fehlt die Turnier-Kennung.'); return; }
    api.get<Info>(`${TO}/oeffentlich/${encodeURIComponent(kennung)}`).then(setInfo).catch((e) => setLadefehler(e.message));
  }, [kennung]);

  const gj = /^\d{4}$/.test(p.geburtsjahr.trim()) ? Number(p.geburtsjahr.trim()) : null;
  const gjOk = gj != null && gj >= 1900 && gj <= jahr;
  const lkOk = !p.lk.trim() || /^(LK\s*)?\d{1,2}([,.]\d)?$/i.test(p.lk.trim());
  const mailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email.trim());
  const ok = !!(p.vorname.trim() && p.nachname.trim() && gjOk && lkOk && mailOk && einwilligung);
  const live = `/turnier-live?t=${encodeURIComponent(kennung)}`;

  async function absenden() {
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ status: string; text: string; link?: string }>(`${TO}/oeffentlich/${encodeURIComponent(kennung)}/anmeldung`, {
        vorname: p.vorname.trim(), nachname: p.nachname.trim(), geburtsjahr: gj, geschlecht: p.geschlecht || null, lk: p.lk.trim() || null,
        email: p.email.trim(), telefon: p.telefon.trim() || null, bemerkung: p.bemerkung.trim() || null, einwilligung, website: p.website,
      });
      setFertig(r);
      window.scrollTo(0, 0);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (ladefehler) {
    return (
      <CenterCard title={orgName} subtitle="Turnier-Anmeldung" logo={logo}>
        <MessageStrip design="Negative" hideCloseButton>{ladefehler}</MessageStrip>
      </CenterCard>
    );
  }
  if (!info) return <CenterCard title={orgName} subtitle="Turnier-Anmeldung" logo={logo}><BusyIndicator active style={{ display: 'block', padding: '1rem 0' }} /></CenterCard>;
  const t = info.turnier;

  if (fertig) {
    const absolut = fertig.link ? `${window.location.origin}${fertig.link}` : null;
    return (
      <CenterCard title={orgName} subtitle={t.name} logo={logo}>
        <MessageStrip design={fertig.status === 'warteliste' ? 'Critical' : 'Positive'} hideCloseButton style={{ marginBottom: '1rem' }}>{fertig.text}</MessageStrip>
        {absolut && <>
          <Text style={{ display: 'block', marginBottom: '0.5rem' }}>
            Dein persönlicher Link – bitte als Lesezeichen speichern und nicht weitergeben. Dort siehst du deine Spiele, trägst Ergebnisse ein oder meldest dich ab:
          </Text>
          <Text style={{ display: 'block', wordBreak: 'break-all', marginBottom: '1rem' }}><b>{absolut}</b></Text>
          <Button design="Emphasized" style={full} onClick={() => { window.location.href = fertig.link!; }}>Zu meinem persönlichen Link</Button>
        </>}
        <Button design="Transparent" style={{ ...full, marginTop: '0.5rem' }} onClick={() => { window.location.href = live; }}>Zur Live-Seite des Turniers</Button>
      </CenterCard>
    );
  }

  const kopf = (
    <>
      <Title level="H4" style={{ marginBottom: '0.25rem' }}>{t.name}</Title>
      <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.5rem' }}>
        {t.modus_text}{t.meldeschluss ? ` · Meldeschluss ${dat(t.meldeschluss)}` : ''}
        {t.max_teilnehmer ? ` · ${info.gemeldet} von ${t.max_teilnehmer} Plätzen belegt` : ` · ${info.gemeldet} gemeldet`}
      </Text>
      {t.beschreibung && <Text style={{ display: 'block', whiteSpace: 'pre-line', marginBottom: '0.75rem' }}>{t.beschreibung}</Text>}
    </>
  );

  if (!info.offen) {
    const grund = t.status === 'anmeldung' ? `Der Meldeschluss (${t.meldeschluss ? dat(t.meldeschluss) : '–'}) ist vorbei.`
      : t.status === 'laeuft' ? 'Das Turnier läuft bereits.' : t.status === 'beendet' ? 'Das Turnier ist beendet.' : `Status: ${STATUS_TEXT[t.status]}.`;
    return (
      <CenterCard title={orgName} subtitle="Turnier-Anmeldung" logo={logo} breit>
        {kopf}
        <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
          Die Anmeldung ist geschlossen. {grund} Bei Fragen wende dich bitte an die Turnierleitung.
        </MessageStrip>
        <Button design="Emphasized" style={full} onClick={() => { window.location.href = live; }}>Zur Live-Seite: Spiele und Ergebnisse</Button>
      </CenterCard>
    );
  }

  return (
    <CenterCard title={orgName} subtitle="Turnier-Anmeldung" logo={logo} breit>
      <form onSubmit={(e) => { e.preventDefault(); absenden(); }}>
        {kopf}
        {info.frei === 0 && (
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '0.75rem' }}>
            Das Feld ist voll – neue Meldungen kommen auf die Warteliste und rücken nach, sobald ein Platz frei wird.
          </MessageStrip>
        )}
        {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}

        <Title level="H5" style={{ margin: '0.5rem 0' }}>Wer spielt mit?</Title>
        <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Feld label="Vorname" required><Input style={full} value={p.vorname} maxlength={60} onInput={(e) => setP({ ...p, vorname: e.target.value })} /></Feld>
          <Feld label="Nachname" required><Input style={full} value={p.nachname} maxlength={60} onInput={(e) => setP({ ...p, nachname: e.target.value })} /></Feld>
        </FlexBox>
        <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Feld label="Geburtsjahr" required>
            <Input style={full} type="Number" value={p.geburtsjahr} placeholder="z. B. 1990" onInput={(e) => setP({ ...p, geburtsjahr: e.target.value })}
                   valueState={p.geburtsjahr && !gjOk ? 'Negative' : 'None'} valueStateMessage={<div>Bitte das Geburtsjahr vierstellig angeben.</div>} />
          </Feld>
          <Feld label="Geschlecht (optional)">
            <Select style={full} onChange={(e) => setP({ ...p, geschlecht: (e.detail.selectedOption as HTMLElement).dataset.g ?? '' })}>
              <Option data-g="" selected={!p.geschlecht}>keine Angabe</Option>
              <Option data-g="w" selected={p.geschlecht === 'w'}>weiblich</Option>
              <Option data-g="m" selected={p.geschlecht === 'm'}>männlich</Option>
              <Option data-g="d" selected={p.geschlecht === 'd'}>divers</Option>
            </Select>
          </Feld>
          <Feld label="LK (optional)">
            <Input style={full} value={p.lk} placeholder="z. B. 18,5" onInput={(e) => setP({ ...p, lk: e.target.value })}
                   valueState={lkOk ? 'None' : 'Negative'} valueStateMessage={<div>LK als Zahl, z. B. 18,5</div>} />
          </Feld>
        </FlexBox>

        <Title level="H5" style={{ margin: '0.5rem 0' }}>Kontakt</Title>
        <FlexBox style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
          <Feld label="E-Mail" required>
            <Input style={full} type="Email" value={p.email} maxlength={120} onInput={(e) => setP({ ...p, email: e.target.value })}
                   valueState={p.email && !mailOk ? 'Negative' : 'None'} valueStateMessage={<div>Bitte eine gültige E-Mail-Adresse angeben.</div>} />
          </Feld>
          <Feld label="Mobil (optional)"><Input style={full} type="Tel" value={p.telefon} maxlength={40} onInput={(e) => setP({ ...p, telefon: e.target.value })} /></Feld>
        </FlexBox>
        <Feld label="Bemerkung an die Turnierleitung (optional)">
          <TextArea rows={2} value={p.bemerkung} maxlength={500} placeholder="z. B. Termine, an denen ich nicht kann" onInput={(e) => setP({ ...p, bemerkung: e.target.value })} />
        </Feld>

        <CheckBox wrappingType="Normal" checked={einwilligung} onChange={(e) => setEinwilligung(e.target.checked)} style={{ marginLeft: '-0.5rem' }}
                  text={`Ich bin einverstanden, dass mein Name (Vorname und erster Buchstabe des Nachnamens) und meine Ergebnisse auf der öffentlichen Live-Seite des Turniers angezeigt werden. Meine Kontaktdaten nutzt ${orgName} nur für die Turnierorganisation. *`} />
        {/* Honigtopf: für Menschen unsichtbar */}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={p.website} onChange={(e) => setP({ ...p, website: e.target.value })}
               style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, opacity: 0 }} aria-hidden />
        <Button design="Emphasized" style={{ ...full, marginTop: '0.5rem' }} onClick={absenden} loading={busy} disabled={!ok}>
          {info.frei === 0 ? 'Auf die Warteliste setzen' : 'Verbindlich anmelden'}
        </Button>
        <Text className="portal-muted portal-small" style={{ display: 'block', marginTop: '0.5rem' }}>
          * Pflichtangaben. Nach der Anmeldung bekommst du einen persönlichen Link (auch per E-Mail). <Link href={live}>Live-Seite des Turniers</Link>
        </Text>
      </form>
    </CenterCard>
  );
}
