import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, CheckBox, FlexBox, Input, Label, Link, MessageStrip, Text, Title } from '@ui5/webcomponents-react';
import { api } from '../api';

/** Zentrierte Karte für Anmeldung, Einrichtung und Passwortwechsel (Fiori-Anmeldeseite). */
function CenterCard({ title, subtitle, logo, children }: { title: string; subtitle?: string; logo?: string; children: ReactNode }) {
  const kuerzel = title.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  return (
    <div className="portal-auth">
      <div className="portal-auth__card">
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

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <FlexBox direction="Column" style={{ gap: '0.25rem', marginBottom: '0.75rem' }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </FlexBox>
  );
}

const full = { width: '100%' };

export interface RegistrierungInfo { pfad: string; titel: string; text: string }

export function LoginPage({ orgName, logo, onDone, registrierung }: { orgName: string; logo?: string; onDone: () => void; registrierung?: RegistrierungInfo | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reg, setReg] = useState(false);
  if (reg && registrierung) return <RegistrierungPage orgName={orgName} logo={logo} info={registrierung} onBack={() => setReg(false)} />;

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
    <CenterCard title={orgName} subtitle="Anmelden" logo={logo}>
      <form onSubmit={submit}>
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
        {registrierung && (
          <div style={{ marginTop: '1rem', textAlign: 'center' }}>
            <Text className="portal-muted">Noch kein Zugang? </Text>
            <Link onClick={() => setReg(true)}>{registrierung.titel}</Link>
          </div>
        )}
      </form>
    </CenterCard>
  );
}

/**
 * Selbstregistrierung (vom Fachmodul bereitgestellt, z. B. Platzbuchung): Name, E-Mail, Benutzername und Kennwort –
 * oder Nachweis eines bestehenden EP3-Kontos mit dem EP3-Kennwort (das dann weiter gilt). Freigabe durch den Verein.
 */
export function RegistrierungPage({ orgName, logo, info, onBack }: { orgName: string; logo?: string; info: RegistrierungInfo; onBack: () => void }) {
  const [meta, setMeta] = useState<{ verein: string; ep3: boolean; hinweis: string } | null>(null);
  const [f, setF] = useState({ vorname: '', nachname: '', email: '', telefon: '', benutzername: '', passwort: '', passwort2: '', nachricht: '', ep3_konto: '', ep3_passwort: '', datenschutz: false });
  const [alt, setAlt] = useState(false);
  const [frei, setFrei] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => { api.get<{ verein: string; ep3: boolean; hinweis: string }>(info.pfad).then(setMeta).catch((e) => setError(e.message)); }, [info.pfad]);
  useEffect(() => {
    if (f.benutzername.length < 3) { setFrei(null); return; }
    const t = setTimeout(() => api.get<{ frei: string | null }>(`${info.pfad}/frei?benutzername=${encodeURIComponent(f.benutzername)}`).then((r) => setFrei(r.frei)).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [f.benutzername, info.pfad]);

  const mismatch = !!f.passwort2 && f.passwort !== f.passwort2;
  const kennwortNoetig = !alt || !!f.passwort;
  const ok = f.vorname && f.nachname && f.email && f.benutzername.length >= 3 && !frei && f.datenschutz
    && (alt ? !!f.ep3_konto && !!f.ep3_passwort : f.passwort.length >= 10) && (!kennwortNoetig || (f.passwort.length >= 10 && !mismatch));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(info.pfad, {
        vorname: f.vorname, nachname: f.nachname, email: f.email, telefon: f.telefon || null, benutzername: f.benutzername, nachricht: f.nachricht || null,
        passwort: f.passwort || null, ep3_konto: alt ? f.ep3_konto : null, ep3_passwort: alt ? f.ep3_passwort : null, datenschutz: f.datenschutz,
      });
      setFertig(r.text);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <CenterCard title={orgName} subtitle={info.titel} logo={logo}>
      {fertig ? (
        <>
          <MessageStrip design="Positive" hideCloseButton style={{ marginBottom: '1rem' }}>{fertig}</MessageStrip>
          <Button design="Emphasized" style={full} onClick={onBack}>Zur Anmeldung</Button>
        </>
      ) : (
        <form onSubmit={submit}>
          <Text style={{ display: 'block', marginBottom: '0.75rem' }} className="portal-muted">{meta?.hinweis ?? info.text}</Text>
          {error && <MessageStrip design="Negative" onClose={() => setError(null)} style={{ marginBottom: '1rem' }}>{error}</MessageStrip>}
          <FlexBox style={{ gap: '0.5rem' }}>
            <Field label="Vorname" required><Input style={full} value={f.vorname} onInput={set('vorname')} /></Field>
            <Field label="Nachname" required><Input style={full} value={f.nachname} onInput={set('nachname')} /></Field>
          </FlexBox>
          <Field label="E-Mail" required><Input style={full} type="Email" value={f.email} onInput={set('email')} /></Field>
          <Field label="Telefon (optional)"><Input style={full} type="Tel" value={f.telefon} onInput={set('telefon')} /></Field>
          <Field label="Gewünschter Benutzername" required>
            <Input style={full} value={f.benutzername} onInput={set('benutzername')} valueState={frei ? 'Negative' : f.benutzername.length >= 3 ? 'Positive' : 'None'}
                   valueStateMessage={<span>{frei ?? 'Benutzername ist frei'}</span>} placeholder="Buchstaben, Ziffern, . _ -" />
          </Field>
          {meta?.ep3 && (
            <div style={{ margin: '0.25rem 0 0.75rem' }}>
              <CheckBox text="Ich habe bereits ein Konto im bisherigen Buchungssystem (EP3)" checked={alt} onChange={(e) => setAlt(e.target.checked)} />
              {alt && (
                <div style={{ padding: '0.5rem 0.75rem', background: 'var(--sapList_HeaderBackground, #f5f6f7)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
                  <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.5rem' }}>
                    Mit den bisherigen EP3-Zugangsdaten wird Ihr Konto zugeordnet – Ihre Buchungen bleiben erhalten und Ihr EP3-Kennwort gilt auch im Portal weiter.
                  </Text>
                  <Field label="EP3-Benutzername oder E-Mail" required><Input style={full} value={f.ep3_konto} onInput={set('ep3_konto')} autocomplete="off" /></Field>
                  <Field label="EP3-Kennwort" required><Input style={full} type="Password" value={f.ep3_passwort} onInput={set('ep3_passwort')} autocomplete="off" /></Field>
                </div>
              )}
            </div>
          )}
          <Field label={alt ? 'Neues Kennwort (optional, sonst gilt das EP3-Kennwort)' : 'Kennwort (mindestens 10 Zeichen)'} required={!alt}>
            <Input style={full} type="Password" value={f.passwort} onInput={set('passwort')} autocomplete="new-password" />
          </Field>
          {(f.passwort || !alt) && (
            <Field label="Kennwort wiederholen" required={!alt}>
              <Input style={full} type="Password" value={f.passwort2} onInput={set('passwort2')} valueState={mismatch ? 'Negative' : 'None'} autocomplete="new-password" />
            </Field>
          )}
          <Field label="Mitteilung an den Verein (optional)"><Input style={full} value={f.nachricht} onInput={set('nachricht')} maxlength={500} /></Field>
          <CheckBox text="Ich bin einverstanden, dass meine Angaben zur Verwaltung und Abrechnung der Platzbuchungen gespeichert werden." checked={f.datenschutz}
                    onChange={(e) => setF((x) => ({ ...x, datenschutz: e.target.checked }))} style={{ marginBottom: '0.75rem', marginLeft: '-0.5rem' }} />
          <Button design="Emphasized" style={full} onClick={() => submit()} loading={busy} disabled={!ok}>Registrierung absenden</Button>
          <div style={{ marginTop: '0.75rem', textAlign: 'center' }}><Link onClick={onBack}>Zurück zur Anmeldung</Link></div>
        </form>
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
