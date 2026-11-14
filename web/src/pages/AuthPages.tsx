import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, CheckBox, DatePicker, FlexBox, Input, Label, Link, MessageStrip, Option, Select, Text, Title } from '@ui5/webcomponents-react';
import { api } from '../api';

/** Zentrierte Karte für Anmeldung, Einrichtung und Passwortwechsel (Fiori-Anmeldeseite). */
export function CenterCard({ title, subtitle, logo, children, breit }: { title: string; subtitle?: string; logo?: string; children: ReactNode; breit?: boolean }) {
  const kuerzel = title.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return (
    <div className="portal-auth" style={breit ? { placeItems: 'start center', height: '100%', overflowY: 'auto' } : undefined}>
      <div className="portal-auth__card" style={breit ? { width: 'min(46rem, 96vw)', maxWidth: 'none' } : undefined}>
        <div className="portal-auth__brand">
          {logo ? <img src={logo} alt="" className="portal-auth__logo" /> : <div className="portal-auth__mark" aria-hidden>{kuerzel || 'P'}</div>}
          <div>
            <h1 className="portal-auth__title">{title}</h1>
            {subtitle && <div className="portal-auth__subtitle">{subtitle}</div>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.75rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

const full = { width: '100%' };

export interface RegistrierungInfo { pfad: string; titel: string; text: string }

export function LoginPage({ orgName, logo, onDone, registrierung, hinweis, onRegistrierung }: {
  orgName: string; logo?: string; onDone: () => void; registrierung?: RegistrierungInfo | null;
  /** Hinweis über dem Formular, z. B. wenn ein Link (Einladung zu einer Veranstaltung) erst nach der Anmeldung weiterführt */
  hinweis?: string;
  /** wird beim Wechsel zur Registrierung gerufen (merkt sich das Ziel des Links für die erste Anmeldung) */
  onRegistrierung?: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState(false);
  const [vergessen, setVergessen] = useState(false);
  if (reg && registrierung) return <RegistrierungPage orgName={orgName} logo={logo} info={registrierung} onBack={() => setReg(false)} />;
  if (vergessen) return <PasswortVergessenPage orgName={orgName} logo={logo} vorbelegt={username} onBack={() => setVergessen(false)} />;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username, password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenterCard title={orgName} subtitle="Zum Vereinsportal anmelden" logo={logo}>
      <form onSubmit={submit}>
        {hinweis && !error && (
          <MessageStrip design="Information" hideCloseButton style={{ marginBottom: '1rem' }}>
            {hinweis}{registrierung ? ` Noch kein Zugang? Dann zuerst unten „${registrierung.titel}“ wählen.` : ''}
          </MessageStrip>
        )}
        {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
        <Field label="Benutzer">
          <Input style={full} value={username} onInput={(e) => setUsername(e.target.value)} name="username" />
        </Field>
        <Field label="Passwort">
          <Input style={full} type="Password" value={password} onInput={(e) => setPassword(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && submit()} name="password" />
        </Field>
        <Button design="Emphasized" style={full} onClick={() => submit()} loading={busy} disabled={!username || !password}>
          Anmelden
        </Button>
        <div style={{ marginTop: '0.75rem', textAlign: 'center' }}>
          <Link onClick={() => setVergessen(true)}>Passwort vergessen?</Link>
        </div>
        {registrierung && (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <Text className="portal-muted" style={{ marginRight: '0.3rem' }}>Noch kein Zugang?</Text>
            <Link onClick={() => { onRegistrierung?.(); setReg(true); }}>{registrierung.titel}</Link>
          </div>
        )}
      </form>
    </CenterCard>
  );
}

/** „Passwort vergessen“: Link zum Zurücksetzen an die hinterlegte E-Mail-Adresse (Antwort verrät nicht, ob es das Konto gibt) */
export function PasswortVergessenPage({ orgName, logo, vorbelegt, onBack }: { orgName: string; logo?: string; vorbelegt?: string; onBack: () => void }) {
  const [konto, setKonto] = useState(vorbelegt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fertig, setFertig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>('/api/auth/passwort-vergessen', { konto });
      setFertig(r.text);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <CenterCard title={orgName} subtitle="Passwort vergessen" logo={logo}>
      {fertig ? (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
          <Button design="Emphasized" style={full} onClick={onBack}>Zur Anmeldung</Button>
        </>
      ) : (
        <form onSubmit={submit}>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
            Geben Sie Ihren Benutzernamen oder Ihre E-Mail-Adresse ein. Sie erhalten einen Link, über den Sie ein neues Kennwort vergeben.
          </Text>
          {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
          <Field label="Benutzer oder E-Mail" required>
            <Input style={full} value={konto} onInput={(e) => setKonto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
          </Field>
          <Button design="Emphasized" style={full} onClick={() => submit()} loading={busy} disabled={!konto.trim()}>Link anfordern</Button>
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}><Link onClick={onBack}>Zurück zur Anmeldung</Link></div>
        </form>
      )}
    </CenterCard>
  );
}

/** Kennwort über einen Einmal-Link festlegen (Passwort vergessen bzw. neuer Zugang ohne Startkennwort) */
export function KennwortSetzenPage({ orgName, logo, token, onDone }: { orgName: string; logo?: string; token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ gueltig: boolean; zweck?: string; username?: string } | null>(null);
  const [f, setF] = useState({ next: '', next2: '' });
  const [error, setError] = useState<string | null>(null);
  const [fertig, setFertig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<typeof info>(`/api/auth/kennwort-link?token=${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(e.message)); }, [token]);
  async function submit() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>('/api/auth/kennwort-setzen', { token, passwort: f.next });
      setFertig(r.text);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <CenterCard title={orgName} subtitle={info?.zweck === 'SETZEN' ? 'Kennwort festlegen' : 'Neues Kennwort'} logo={logo}>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      {fertig ? (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
          <Button design="Emphasized" style={full} onClick={onDone}>Zur Anmeldung</Button>
        </>
      ) : !info ? null : !info.gueltig ? (
        <>
          <MessageStrip design="Critical" hideCloseButton style={{ marginBottom: '1rem' }}>
            Der Link ist ungültig, abgelaufen oder wurde bereits verwendet. Fordern Sie auf der Anmeldeseite über „Passwort vergessen?“ einen neuen an.
          </MessageStrip>
          <Button design="Emphasized" style={full} onClick={onDone}>Zur Anmeldung</Button>
        </>
      ) : (
        <>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>Benutzer: <b>{info.username}</b></Text>
          <Field label="Neues Kennwort (mind. 10 Zeichen)" required>
            <Input style={full} type="Password" value={f.next} onInput={(e) => setF({ ...f, next: e.target.value })} />
          </Field>
          <Field label="Kennwort wiederholen" required>
            <Input style={full} type="Password" value={f.next2} onInput={(e) => setF({ ...f, next2: e.target.value })}
                   valueState={f.next2 && f.next !== f.next2 ? 'Negative' : 'None'} />
          </Field>
          <Button design="Emphasized" style={full} loading={busy} onClick={submit} disabled={f.next.length < 10 || f.next !== f.next2}>Kennwort speichern</Button>
        </>
      )}
    </CenterCard>
  );
}

/**
 * Selbstregistrierung in Schritten (#10, vom Fachmodul bereitgestellt):
 *   1 Mitglied oder externer Hallennutzer · 2 E-Mail (Mitglied: + Geburtsdatum) – der Server sucht im Bestand; bei einem
 *   Treffer entfällt die Eingabe von Name und Anschrift · (2b ohne Treffer: Name und Anschrift) · 3 Benutzername und Kennwort ·
 *   4 Wie es weitergeht (extern: Bestätigungsmail, Mitglied: Freigabe durch den Vorstand).
 */
type RegSchritt = 'ART' | 'KENNUNG' | 'DATEN' | 'KENNWORT' | 'FERTIG';
export function RegistrierungPage({ orgName, logo, info, onBack }: { orgName: string; logo?: string; info: RegistrierungInfo; onBack: () => void }) {
  const [schritt, setSchritt] = useState<RegSchritt>('ART');
  const [art, setArt] = useState<'MITGLIED' | 'EXTERN'>('MITGLIED');
  const [f, setF] = useState({ anrede: '', vorname: '', nachname: '', strasse: '', plz: '', ort: '', email: '', telefon: '', benutzername: '', passwort: '', passwort2: '', datenschutz: false });
  const [geburtsdatum, setGeburtsdatum] = useState('');
  /** Ergebnis der Suche im Bestand: Treffer → Name und Anschrift kommen vom Verein */
  const [treffer, setTreffer] = useState<{ name: string } | null>(null);
  const [frei, setFrei] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => {
    if (f.benutzername.length < 3) { setFrei(null); return; }
    const t = setTimeout(() => api.get<{ frei: string | null }>(`${info.pfad}/frei?benutzername=${encodeURIComponent(f.benutzername)}`).then((r) => setFrei(r.frei)).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [f.benutzername, info.pfad]);

  const mitglied = art === 'MITGLIED';
  const email = f.email.trim();
  const plzOk = /^\d{4,5}$/.test(f.plz.trim());
  const strasseOk = f.strasse.trim().length >= 3 && /\d/.test(f.strasse);
  const datenOk = !!f.anrede && !!f.vorname.trim() && !!f.nachname.trim() && strasseOk && plzOk && f.ort.trim().length >= 2;
  // Eingabetaste im Schritt „E-Mail“ löst nur die Suche aus – und nur mit vollständigen Angaben (#10)
  const kennungOk = /^\S+@\S+\.\S+$/.test(email) && (!mitglied || !!geburtsdatum);
  const mismatch = !!f.passwort2 && f.passwort !== f.passwort2;
  const kennwortOk = f.benutzername.length >= 3 && !frei && f.passwort.length >= 10 && f.passwort === f.passwort2 && f.datenschutz;
  const schritte: RegSchritt[] = treffer ? ['ART', 'KENNUNG', 'KENNWORT', 'FERTIG'] : ['ART', 'KENNUNG', 'DATEN', 'KENNWORT', 'FERTIG'];
  const nr = schritte.indexOf(schritt) + 1;

  async function pruefen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ treffer: boolean; name?: string }>(`${info.pfad}/pruefen`, { art, email, geburtsdatum: mitglied ? geburtsdatum : null });
      setTreffer(r.treffer ? { name: r.name ?? '' } : null);
      setSchritt(r.treffer ? 'KENNWORT' : 'DATEN');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function absenden() {
    setBusy(true); setError(null);
    try {
      const basis = { art, email, benutzername: f.benutzername, passwort: f.passwort, datenschutz: f.datenschutz, geburtsdatum: mitglied ? geburtsdatum || null : null };
      const r = await api.post<{ text: string }>(info.pfad, treffer ? { ...basis, ausBestand: true }
        : { ...basis, anrede: f.anrede, vorname: f.vorname, nachname: f.nachname, strasse: f.strasse, plz: f.plz, ort: f.ort, telefon: f.telefon || null });
      setFertig(r.text);
      setSchritt('FERTIG');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const zurueck = () => { setError(null); setSchritt(schritte[Math.max(0, schritte.indexOf(schritt) - 1)]); };
  const wahl = (a: 'MITGLIED' | 'EXTERN') => { setArt(a); setTreffer(null); setError(null); setSchritt('KENNUNG'); };
  const fuss = (weiter: ReactNode) => (
    <>
      {weiter}
      <FlexBox justifyContent="SpaceBetween" style={{ marginTop: '0.75rem' }}>
        <Link onClick={zurueck}>Zurück</Link>
        <Link onClick={onBack}>Zur Anmeldung</Link>
      </FlexBox>
    </>
  );

  return (
    <CenterCard title={orgName} subtitle={info.titel} logo={logo}>
      {schritt !== 'FERTIG' && <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>Schritt {nr} von {schritte.length - 1}</Text>}
      {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}

      {schritt === 'ART' && (
        <>
          <Title level="H5" style={{ marginBottom: '0.75rem' }}>Wer möchte sich registrieren?</Title>
          <Button design="Emphasized" icon="group" style={{ ...full, marginBottom: '0.5rem' }} onClick={() => wahl('MITGLIED')}>Ich bin Mitglied des Vereins</Button>
          <Button icon="visits" style={full} onClick={() => wahl('EXTERN')}>Ich bin externer Hallennutzer (kein Mitglied)</Button>
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}><Link onClick={onBack}>Zurück zur Anmeldung</Link></div>
        </>
      )}

      {schritt === 'KENNUNG' && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (kennungOk && !busy) pruefen(); }}>
          <Title level="H5" style={{ marginBottom: '0.25rem' }}>{mitglied ? 'Mitglied' : 'Externer Hallennutzer'}</Title>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
            {mitglied ? 'Mit E-Mail-Adresse und Geburtsdatum suchen wir Sie im Mitgliederverzeichnis.' : 'Mit der E-Mail-Adresse prüfen wir, ob wir Sie schon als Hallenkunden kennen.'}
          </Text>
          <Field label="E-Mail" required><Input style={full} type="Email" value={f.email} onInput={set('email')} /></Field>
          {mitglied && <Field label="Geburtsdatum" required><DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={geburtsdatum} onChange={(e) => setGeburtsdatum(e.detail.value)} /></Field>}
          {fuss(<Button design="Emphasized" style={full} loading={busy} disabled={!kennungOk} onClick={pruefen}>Weiter</Button>)}
        </form>
      )}

      {schritt === 'DATEN' && (
        <>
          <Title level="H5" style={{ marginBottom: '0.25rem' }}>Ihre Angaben</Title>
          <Text className="portal-muted" style={{ display: 'block', marginBottom: '0.75rem' }}>
            {mitglied ? 'Mit diesen Angaben haben wir kein Mitglied ohne Zugang gefunden. Bitte ergänzen Sie Name und Anschrift – der Vorstand gleicht sie ab.'
              : 'Bitte ergänzen Sie Name und Anschrift für die Abrechnung der Buchungen.'}
          </Text>
          <Field label="Anrede" required>
            <Select style={full} onChange={(e) => setF((x) => ({ ...x, anrede: (e.detail.selectedOption as HTMLElement).dataset.a ?? '' }))}>
              <Option data-a="" selected={!f.anrede}>bitte wählen</Option>
              {['Frau', 'Herr', 'Divers'].map((a) => <Option key={a} data-a={a} selected={f.anrede === a}>{a}</Option>)}
            </Select>
          </Field>
          <FlexBox style={{ gap: '0.5rem' }}>
            <Field label="Vorname" required><Input style={full} value={f.vorname} onInput={set('vorname')} /></Field>
            <Field label="Nachname" required><Input style={full} value={f.nachname} onInput={set('nachname')} /></Field>
          </FlexBox>
          <Field label="Straße und Hausnummer" required>
            <Input style={full} value={f.strasse} onInput={set('strasse')} valueState={f.strasse && !strasseOk ? 'Negative' : 'None'}
                   valueStateMessage={<span>Bitte Straße mit Hausnummer angeben</span>} />
          </Field>
          <FlexBox style={{ gap: '0.5rem' }}>
            <Field label="PLZ" required>
              <Input style={full} value={f.plz} onInput={set('plz')} valueState={f.plz && !plzOk ? 'Negative' : 'None'} valueStateMessage={<span>4 oder 5 Ziffern</span>} />
            </Field>
            <Field label="Ort" required><Input style={full} value={f.ort} onInput={set('ort')} /></Field>
          </FlexBox>
          <Field label="Telefon (optional)"><Input style={full} type="Tel" value={f.telefon} onInput={set('telefon')} /></Field>
          {fuss(<Button design="Emphasized" style={full} disabled={!datenOk} onClick={() => { setError(null); setSchritt('KENNWORT'); }}>Weiter</Button>)}
        </>
      )}

      {schritt === 'KENNWORT' && (
        <>
          <Title level="H5" style={{ marginBottom: '0.25rem' }}>Kennwort wählen</Title>
          {treffer && (
            <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>
              Wir haben Sie gefunden{treffer.name ? `: ${treffer.name}` : ''}. Name und Anschrift übernehmen wir aus {mitglied ? 'dem Mitgliederverzeichnis' : 'Ihrem bisherigen Kundenkonto'}.
            </MessageStrip>
          )}
          <Field label="Benutzername (für die Anmeldung)" required>
            {/* bewusst leer und ohne Vorschlag des Browsers: den Benutzernamen wählt jeder selbst (#10) */}
            <Input data-kein-autofill style={full} value={f.benutzername} onInput={set('benutzername')} valueState={frei ? 'Negative' : f.benutzername.length >= 3 ? 'Positive' : 'None'}
                   valueStateMessage={<span>{frei ?? 'Benutzername ist frei'}</span>} placeholder="Buchstaben, Ziffern, . _ - @" />
          </Field>
          <Field label="Kennwort (mindestens 10 Zeichen)" required><Input style={full} type="Password" value={f.passwort} onInput={set('passwort')} /></Field>
          <Field label="Kennwort wiederholen" required>
            <Input style={full} type="Password" value={f.passwort2} onInput={set('passwort2')} valueState={mismatch ? 'Negative' : 'None'} valueStateMessage={<span>Die Kennwörter stimmen nicht überein</span>} />
          </Field>
          <CheckBox text="Ich bin einverstanden, dass meine Angaben zur Verwaltung und Abrechnung der Platzbuchungen gespeichert werden." checked={f.datenschutz} wrappingType="Normal"
                    onChange={(e) => setF((x) => ({ ...x, datenschutz: e.target.checked }))} style={{ marginBottom: '0.75rem', marginLeft: '-0.5rem' }} />
          {fuss(<Button design="Emphasized" style={full} loading={busy} disabled={!kennwortOk} onClick={absenden}>Registrierung absenden</Button>)}
        </>
      )}

      {schritt === 'FERTIG' && (
        <>
          <Title level="H5" style={{ marginBottom: '0.5rem' }}>Geschafft – so geht es weiter</Title>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '0.75rem' }}>{fertig}</MessageStrip>
          <Text style={{ display: 'block', marginBottom: '1rem' }}>
            {mitglied
              ? 'Der Vorstand gleicht Ihre Angaben mit dem Mitgliederverzeichnis ab und gibt den Zugang frei. Bis dahin ist keine Anmeldung möglich.'
              : 'Bei externen Hallennutzern ist die Registrierung mit dem Link aus der Bestätigungsmail abgeschlossen – danach können Sie sofort Plätze buchen.'}
          </Text>
          <Button design="Emphasized" style={full} onClick={onBack}>Zur Anmeldung</Button>
        </>
      )}
    </CenterCard>
  );
}

export function SetupPage({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ orgName: '', username: 'admin', displayName: '', email: '', password: '', password2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const mismatch = !!f.password2 && f.password !== f.password2;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/setup', f);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenterCard title="Einrichtung" subtitle="Organisation und ersten Administrator anlegen">
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Title level="H5" style={{ marginBottom: '0.5rem' }}>Organisation</Title>
      <Field label="Name" required><Input style={full} value={f.orgName} onInput={set('orgName')} placeholder="z. B. Tennisclub Oberthal e.V." /></Field>
      <Title level="H5" style={{ margin: '1rem 0 0.5rem' }}>Administrator</Title>
      <Field label="Benutzername" required><Input style={full} value={f.username} onInput={set('username')} /></Field>
      <Field label="Name" required><Input style={full} value={f.displayName} onInput={set('displayName')} /></Field>
      <Field label="E-Mail"><Input style={full} type="Email" value={f.email} onInput={set('email')} /></Field>
      <Field label="Passwort (mind. 10 Zeichen)" required><Input style={full} type="Password" value={f.password} onInput={set('password')} /></Field>
      <Field label="Passwort wiederholen" required>
        <Input style={full} type="Password" value={f.password2} onInput={set('password2')}
               valueState={mismatch ? 'Negative' : 'None'}
               valueStateMessage={<div>Passwörter stimmen nicht überein</div>} />
      </Field>
      <Button design="Emphasized" style={full} loading={busy} onClick={submit}
              disabled={!f.orgName || !f.username || !f.displayName || f.password.length < 10 || f.password !== f.password2}>
        Einrichten
      </Button>
    </CenterCard>
  );
}

/** Passwort ändern – als eigene Seite (erzwungen) oder im Dialog nutzbar. */
export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ current: '', next: '', next2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password', { current: f.current, next: f.next });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <MessageStrip design="Negative" hideCloseButton style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
      <Field label="Aktuelles Passwort" required><Input style={full} type="Password" value={f.current} onInput={set('current')} /></Field>
      <Field label="Neues Passwort (mind. 10 Zeichen)" required><Input style={full} type="Password" value={f.next} onInput={set('next')} /></Field>
      <Field label="Neues Passwort wiederholen" required>
        <Input style={full} type="Password" value={f.next2} onInput={set('next2')}
               valueState={f.next2 && f.next !== f.next2 ? 'Negative' : 'None'} />
      </Field>
      <Button design="Emphasized" style={full} loading={busy} onClick={submit}
              disabled={!f.current || f.next.length < 10 || f.next !== f.next2}>
        Passwort ändern
      </Button>
    </>
  );
}

export function ForcedPasswordPage({ onDone, onLogout }: { onDone: () => void; onLogout: () => void }) {
  return (
    <CenterCard title="Neues Passwort" subtitle="Bitte vergeben Sie vor der ersten Nutzung ein eigenes Passwort.">
      <ChangePasswordForm onDone={onDone} />
      <Button design="Transparent" style={{ ...full, marginTop: '0.5rem' }} onClick={onLogout}>Abmelden</Button>
    </CenterCard>
  );
}
