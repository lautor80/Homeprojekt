import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, CardHeader, FlexBox, Input, Label, MessageStrip, Title } from '@ui5/webcomponents-react';
import { api } from '../api';

/** Zentrierte Karte für Anmeldung, Einrichtung und Passwortwechsel. */
function CenterCard({ title, subtitle, logo, children }: { title: string; subtitle?: string; logo?: string; children: ReactNode }) {
  return (
    <FlexBox justifyContent="Center" alignItems="Center" style={{ minHeight: '100%', padding: '1rem', boxSizing: 'border-box' }}>
      <Card style={{ width: 'min(440px, 100%)' }} header={<CardHeader titleText={title} subtitleText={subtitle} />}>
        <div style={{ padding: '1rem 1.25rem 1.5rem' }}>
          {logo && <img src={logo} alt="" style={{ maxHeight: 72, display: 'block', margin: '0 auto 1rem' }} />}
          {children}
        </div>
      </Card>
    </FlexBox>
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

export function LoginPage({ orgName, logo, onDone }: { orgName: string; logo?: string; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      </form>
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
