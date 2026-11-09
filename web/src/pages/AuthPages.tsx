import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, CheckBox, DatePicker, FlexBox, Input, Label, Link, MessageStrip, Option, RadioButton, Select, Text, Title } from '@ui5/webcomponents-react';
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

export function LoginPage({ orgName, logo, onDone, registrierung }: { orgName: string; logo?: string; onDone: () => void; registrierung?: RegistrierungInfo | null }) {
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
            <Text className="portal-muted">Noch kein Zugang? </Text>
            <Link onClick={() => setReg(true)}>{registrierung.titel}</Link>
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
 * Selbstregistrierung (vom Fachmodul bereitgestellt, z. B. Platzbuchung): Name, E-Mail, Benutzername und Kennwort –
 * oder Nachweis eines bestehenden EP3-Kontos mit dem EP3-Kennwort (das dann weiter gilt). Freigabe durch den Verein.
 */
export function RegistrierungPage({ orgName, logo, info, onBack }: { orgName: string; logo?: string; info: RegistrierungInfo; onBack: () => void }) {
  const [meta, setMeta] = useState<{ verein: string; ep3: boolean; hinweis: string; mitglied?: boolean } | null>(null);
  const [f, setF] = useState({ anrede: '', vorname: '', nachname: '', strasse: '', plz: '', ort: '', email: '', telefon: '', benutzername: '', passwort: '', passwort2: '', nachricht: '', ep3_konto: '', ep3_passwort: '', datenschutz: false });
  /** Mitglied (Prüfung durch den Verein) oder externer Hallennutzer (Freischaltung nach E-Mail-Bestätigung) */
  const [art, setArt] = useState<'MITGLIED' | 'EXTERN' | null>(null);
  const [nachweis, setNachweis] = useState<'GEBURTSDATUM' | 'MITGLIEDSNR'>('GEBURTSDATUM');
  const [geburtsdatum, setGeburtsdatum] = useState('');
  const [mitgliedsnr, setMitgliedsnr] = useState('');
  /** Schnellweg für Mitglieder: E-Mail + Geburtsdatum → Link an die hinterlegte Adresse; null = noch nicht geprüft */
  const [schnell, setSchnell] = useState<{ treffer: boolean; text: string } | null>(null);
  async function schnellPruefen() {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ treffer: boolean; text: string }>(`${info.pfad}/schnell`, { email: f.email, geburtsdatum });
      setSchnell(r);
      if (r.treffer) setFertig(r.text);
      else setNachweis('GEBURTSDATUM');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const [alt, setAlt] = useState(false);
  const [frei, setFrei] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fertig, setFertig] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => { api.get<{ verein: string; ep3: boolean; hinweis: string; mitglied?: boolean }>(info.pfad).then(setMeta).catch((e) => setError(e.message)); }, [info.pfad]);
  useEffect(() => {
    if (f.benutzername.length < 3) { setFrei(null); return; }
    const t = setTimeout(() => api.get<{ frei: string | null }>(`${info.pfad}/frei?benutzername=${encodeURIComponent(f.benutzername)}`).then((r) => setFrei(r.frei)).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [f.benutzername, info.pfad]);

  const mismatch = !!f.passwort2 && f.passwort !== f.passwort2;
  const kennwortNoetig = !alt || !!f.passwort;
  const artOk = !meta?.mitglied || art === 'EXTERN' || (art === 'MITGLIED' && (nachweis === 'GEBURTSDATUM' ? !!geburtsdatum : !!mitgliedsnr.trim()));
  const plzOk = /^\d{4,5}$/.test(f.plz.trim());
  const strasseOk = f.strasse.trim().length >= 3 && /\d/.test(f.strasse);
  const ok = artOk && f.anrede && f.vorname && f.nachname && strasseOk && plzOk && f.ort.trim().length >= 2 && f.email && f.benutzername.length >= 3 && !frei && f.datenschutz
    && (alt ? !!f.ep3_konto && !!f.ep3_passwort : f.passwort.length >= 10) && (!kennwortNoetig || (f.passwort.length >= 10 && !mismatch));

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ text: string }>(info.pfad, {
        anrede: f.anrede, vorname: f.vorname, nachname: f.nachname, strasse: f.strasse, plz: f.plz, ort: f.ort,
        email: f.email, telefon: f.telefon || null, benutzername: f.benutzername, nachricht: f.nachricht || null,
        passwort: f.passwort || null, ep3_konto: alt ? f.ep3_konto : null, ep3_passwort: alt ? f.ep3_passwort : null, datenschutz: f.datenschutz,
        ...(meta?.mitglied ? {
          art: art ?? 'EXTERN',
          geburtsdatum: art === 'MITGLIED' && nachweis === 'GEBURTSDATUM' ? geburtsdatum || null : null,
          mitgliedsnr: art === 'MITGLIED' && nachweis === 'MITGLIEDSNR' ? mitgliedsnr.trim() || null : null,
        } : {}),
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
          {meta?.mitglied && (
            <div style={{ marginBottom: '0.75rem' }}>
              <Label required showColon>Ich bin</Label>
              <RadioButton name="reg-art" text="Mitglied des Vereins" checked={art === 'MITGLIED'} onChange={() => setArt('MITGLIED')} />
              <RadioButton name="reg-art" text="Externer Hallennutzer (kein Mitglied)" checked={art === 'EXTERN'} onChange={() => setArt('EXTERN')} />
              {art === 'MITGLIED' && !schnell && (
                <div style={{ padding: '0.5rem 0.75rem', background: 'var(--sapList_HeaderBackground, #f5f6f7)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
                  <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.25rem' }}>
                    Schnellweg: Mit der beim Verein hinterlegten E-Mail-Adresse und Ihrem Geburtsdatum finden wir Sie direkt – Sie erhalten einen Link und wählen nur noch Benutzername und Kennwort.
                  </Text>
                  <Field label="E-Mail (beim Verein hinterlegt)" required><Input style={full} type="Email" value={f.email} onInput={set('email')} /></Field>
                  <Field label="Geburtsdatum" required><DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={geburtsdatum} onChange={(e) => setGeburtsdatum(e.detail.value)} /></Field>
                  <Button design="Emphasized" style={full} loading={busy} disabled={!f.email.includes('@') || !geburtsdatum} onClick={schnellPruefen}>Weiter</Button>
                  <div style={{ marginTop: '0.5rem', textAlign: 'center' }}>
                    <Link onClick={() => setSchnell({ treffer: false, text: '' })}>Ohne Schnellweg vollständig registrieren</Link>
                  </div>
                </div>
              )}
              {art === 'MITGLIED' && schnell && !schnell.treffer && schnell.text && (
                <MessageStrip design="Information" hideCloseButton style={{ margin: '0.5rem 0' }}>{schnell.text}</MessageStrip>
              )}
              {art === 'MITGLIED' && schnell && (
                <div style={{ padding: '0.5rem 0.75rem', background: 'var(--sapList_HeaderBackground, #f5f6f7)', borderRadius: 'var(--portal-radius, 0.75rem)' }}>
                  <Text className="portal-muted portal-small" style={{ display: 'block', marginBottom: '0.25rem' }}>
                    Zum Abgleich mit dem Mitgliederverzeichnis – bitte eine Angabe wählen:
                  </Text>
                  <RadioButton name="reg-nachweis" text="Geburtsdatum" checked={nachweis === 'GEBURTSDATUM'} onChange={() => setNachweis('GEBURTSDATUM')} />
                  <RadioButton name="reg-nachweis" text="Mitgliedsnummer" checked={nachweis === 'MITGLIEDSNR'} onChange={() => setNachweis('MITGLIEDSNR')} />
                  {nachweis === 'GEBURTSDATUM'
                    ? <Field label="Geburtsdatum" required><DatePicker style={full} formatPattern="dd.MM.yyyy" valueFormat="yyyy-MM-dd" value={geburtsdatum} onChange={(e) => setGeburtsdatum(e.detail.value)} /></Field>
                    : <Field label="Mitgliedsnummer" required><Input style={full} value={mitgliedsnr} onInput={(e) => setMitgliedsnr(e.target.value)} /></Field>}
                </div>
              )}
            </div>
          )}
          {!(art === 'MITGLIED' && !schnell) && (<>
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
                  <Field label="EP3-Benutzername oder E-Mail" required><Input style={full} value={f.ep3_konto} onInput={set('ep3_konto')} /></Field>
                  <Field label="EP3-Kennwort" required><Input style={full} type="Password" value={f.ep3_passwort} onInput={set('ep3_passwort')} /></Field>
                </div>
              )}
            </div>
          )}
          <Field label={alt ? 'Neues Kennwort (optional, sonst gilt das EP3-Kennwort)' : 'Kennwort (mindestens 10 Zeichen)'} required={!alt}>
            <Input style={full} type="Password" value={f.passwort} onInput={set('passwort')} />
          </Field>
          {(f.passwort || !alt) && (
            <Field label="Kennwort wiederholen" required={!alt}>
              <Input style={full} type="Password" value={f.passwort2} onInput={set('passwort2')} valueState={mismatch ? 'Negative' : 'None'} />
            </Field>
          )}
          <Field label="Mitteilung an den Verein (optional)"><Input style={full} value={f.nachricht} onInput={set('nachricht')} maxlength={500} /></Field>
          <CheckBox text="Ich bin einverstanden, dass meine Angaben zur Verwaltung und Abrechnung der Platzbuchungen gespeichert werden." checked={f.datenschutz}
                    onChange={(e) => setF((x) => ({ ...x, datenschutz: e.target.checked }))} style={{ marginBottom: '0.75rem', marginLeft: '-0.5rem' }} />
          <Button design="Emphasized" style={full} onClick={() => submit()} loading={busy} disabled={!ok}>Registrierung absenden</Button>
          </>)}
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
