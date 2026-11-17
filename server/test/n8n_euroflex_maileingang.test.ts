/**
 * n8n-Workflow „Euroflex Maileingang“ (docs/n8n/euroflex-maileingang.json) – ohne n8n, ohne Datenbank, ohne Netz:
 * Aufbau der Datei (Knoten, Verbindungen, keine Zugangsdaten) und die Logik der Code-Knoten mit nachgestellten Antworten
 * von Microsoft Graph und Portal. Die Lieferung muss dem Vertrag in docs/euroflex-mailworkflows.md („Schnittstelle für n8n“)
 * entsprechen. Gegen ein echtes n8n und ein echtes Postfach lässt sich das nur dort prüfen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Knoten { name: string; type: string; parameters: Record<string, any>; credentials?: Record<string, { id: string; name: string }>; onError?: string; retryOnFail?: boolean }
const datei = fileURLToPath(new URL('../../docs/n8n/euroflex-maileingang.json', import.meta.url));
const roh = fs.readFileSync(datei, 'utf8');
const wf = JSON.parse(roh) as { name: string; nodes: Knoten[]; connections: Record<string, { main: { node: string }[][] }>; settings: Record<string, unknown> };
const knoten = (name: string) => { const k = wf.nodes.find((n) => n.name === name); assert.ok(k, `Knoten ${name} fehlt`); return k; };
const ziele = (von: string) => (wf.connections[von]?.main ?? []).map((ausgang) => ausgang.map((z) => z.node));

type Element = { json: Record<string, any> };
/** Code-Knoten ausführen: $input = Eingang, $('Name') = Ausgang eines früheren Knotens (letzter Lauf) */
function ausfuehren(name: string, eingang: Element[], bisher: Record<string, Element[]>, code?: string): Element[] {
  const $ = (n: string) => {
    if (!(n in bisher)) throw new Error(`Knoten ${n} wurde nicht ausgeführt`);
    return { first: () => bisher[n][0], all: () => bisher[n] };
  };
  const f = new Function('$input', '$', code ?? (knoten(name).parameters.jsCode as string));
  return f({ first: () => eingang[0], all: () => eingang }, $) as Element[];
}

const POSTFACH = 'auftraege@example.org';
const KONF: Element = { json: { postfach: POSTFACH, quellordner: 'Inbox', zielwurzel: 'Inbox', max: 50 } };
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** Beispiel wie GET /users/{p}/mailFolders/Inbox/messages mit $select liefert */
const graphMail = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  internetMessageId: `<${id}@mail.kunde.example>`,
  subject: 'AW: Lieferschein 2026_0153',
  from: { emailAddress: { name: 'Einkauf Kunde', address: 'einkauf@kunde.example' } },
  toRecipients: [{ emailAddress: { name: 'Aufträge', address: POSTFACH } }, { emailAddress: { address: 'dispo@example.org' } }],
  receivedDateTime: '2026-11-17T06:12:00Z',
  hasAttachments: true,
  body: { contentType: 'html', content: '<html><head><style>p{color:red}</style></head><body><p>Guten&nbsp;Tag,</p><p>anbei der Scan zu <b>2026_0153</b> &amp; die CMR.<br>Gr&uuml;&szlig;e</p></body></html>' },
  internetMessageHeaders: [
    { name: 'Received', value: 'from mail.kunde.example' },
    { name: 'In-Reply-To', value: '<m1@example.org>' },
    { name: 'references', value: '<m0@example.org>\r\n <m1@example.org>' },
  ],
  ...extra,
});
const anhaengeOk = () => ({
  statusCode: 200,
  body: { value: [
    { '@odata.type': '#microsoft.graph.fileAttachment', name: 'Scan.pdf', contentType: 'application/pdf', size: 20, isInline: false, contentBytes: b64('%PDF-1 Scan') },
    { '@odata.type': '#microsoft.graph.fileAttachment', name: 'logo.png', contentType: 'image/png', size: 4, isInline: true, contentBytes: b64('PNG') },
    { '@odata.type': '#microsoft.graph.itemAttachment', name: 'Weitergeleitet', contentType: null, size: 900 },
    { '@odata.type': '#microsoft.graph.referenceAttachment', name: 'Link.url', contentType: null, size: 1 },
  ] },
});

/** Lauf bis „Für Portal packen“: Mails lesen (Graph) → aufteilen → Anhänge laden (Graph) → packen */
function packen(mails: Record<string, unknown>[], anhaenge: (id: string) => Record<string, any> = anhaengeOk) {
  const aus: Record<string, Element[]> = { Konfiguration: [KONF] };
  aus['Mails lesen'] = [{ json: { statusCode: 200, body: { value: mails } } }];
  aus['Mails aufteilen'] = ausfuehren('Mails aufteilen', aus['Mails lesen'], aus);
  aus['Anhänge laden'] = aus['Mails aufteilen'].map((m) => ({ json: anhaenge(m.json.graph_id) }));
  aus['Für Portal packen'] = ausfuehren('Für Portal packen', aus['Anhänge laden'], aus);
  aus['Lieferbar?'] = aus['Für Portal packen'].filter((e) => e.json.ok === true);
  return aus;
}

/** nachgestelltes Postfach für die Ordnerschleife: Ordner-ID → { name, eltern } */
function postfachSimulation(vorhanden: Record<string, { name: string; eltern: string }>, stoerung: (art: 'suchen' | 'anlegen', name: string) => Record<string, any> | null = () => null) {
  const ordner = { ...vorhanden };
  const aufrufe: string[] = [];
  let n = 0;
  return {
    ordner, aufrufe,
    suchen(eltern: string, name: string) {
      aufrufe.push(`suchen ${eltern}/${name}`);
      const s = stoerung('suchen', name); if (s) return s;
      return { statusCode: 200, body: { value: Object.entries(ordner).filter(([, o]) => o.eltern === eltern && o.name.toLowerCase() === name.toLowerCase()).map(([id, o]) => ({ id, displayName: o.name })) } };
    },
    anlegen(eltern: string, name: string) {
      aufrufe.push(`anlegen ${eltern}/${name}`);
      const s = stoerung('anlegen', name); if (s) return s;
      const id = `neu-${++n}`;
      ordner[id] = { name, eltern };
      return { statusCode: 201, body: { id, displayName: name, parentFolderId: eltern } };
    },
  };
}

/** Ordnerschleife wie in n8n: Ordner planen → Ordner fehlt? → Ordner suchen → Suche auswerten → Anlegen? → (Ordner anlegen → Anlage auswerten) → Ordner planen … */
function ordnerAufloesen(aus: Record<string, Element[]>, sim: ReturnType<typeof postfachSimulation>) {
  let eingang = aus['Antwort auswerten'];
  for (let runde = 0; runde < 100; runde++) {
    aus['Ordner planen'] = ausfuehren('Ordner planen', eingang, aus);
    const s = aus['Ordner planen'][0].json;
    if (s.schritt === null) {
      aus['Verschieben aufteilen'] = ausfuehren('Verschieben aufteilen', aus['Ordner planen'], aus);
      return aus;
    }
    aus['Ordner suchen'] = [{ json: sim.suchen(s.schritt.eltern, s.schritt.name) }];
    aus['Suche auswerten'] = ausfuehren('Suche auswerten', aus['Ordner suchen'], aus);
    if (aus['Suche auswerten'][0].json.anlegen === true) {
      const st = aus['Suche auswerten'][0].json.schritt;
      aus['Ordner anlegen'] = [{ json: sim.anlegen(st.eltern, st.name) }];
      aus['Anlage auswerten'] = ausfuehren('Anlage auswerten', aus['Ordner anlegen'], aus);
      eingang = aus['Anlage auswerten'];
    } else eingang = aus['Suche auswerten'];
  }
  throw new Error('Ordnerschleife endet nicht');
}

test('Workflow-Datei: Knoten, Verbindungen, Auslöser, keine Zugangsdaten', () => {
  assert.equal(wf.name, 'Euroflex Maileingang');
  assert.equal(wf.settings.executionOrder, 'v1');
  const namen = wf.nodes.map((n) => n.name);
  assert.equal(new Set(namen).size, namen.length, 'Knotennamen eindeutig');
  for (const [von, c] of Object.entries(wf.connections)) {
    assert.ok(namen.includes(von), `Verbindung ab unbekanntem Knoten ${von}`);
    for (const ziel of c.main.flat()) assert.ok(namen.includes(ziel.node), `Verbindung zu unbekanntem Knoten ${ziel.node}`);
  }
  const ausloeser = ['Manuell starten', 'Alle 5 Minuten', 'Webhook Portal'];
  const mitEingang = new Set(Object.values(wf.connections).flatMap((c) => c.main.flat().map((z) => z.node)));
  for (const n of wf.nodes) if (![...ausloeser, 'Hinweis'].includes(n.name)) assert.ok(mitEingang.has(n.name), `${n.name} hat keinen Eingang`);
  for (const a of ausloeser) assert.deepEqual(ziele(a), [['Konfiguration']]);
  assert.equal(knoten('Manuell starten').type, 'n8n-nodes-base.manualTrigger');
  assert.deepEqual(knoten('Alle 5 Minuten').parameters.rule, { interval: [{ field: 'minutes', minutesInterval: 5 }] });
  const w = knoten('Webhook Portal');
  assert.equal(w.type, 'n8n-nodes-base.webhook');
  assert.equal(w.parameters.path, 'euroflex-maileingang');
  assert.equal(w.parameters.authentication, 'headerAuth');
  assert.equal(w.parameters.httpMethod, 'POST');

  // Hauptweg und Ordnerschleife
  const kette = ['Konfiguration', 'Mails lesen', 'Mails aufteilen', 'Anhänge laden', 'Für Portal packen', 'Lieferbar?', 'An Portal liefern', 'Antwort auswerten', 'Ordner planen', 'Ordner fehlt?'];
  for (let i = 0; i < kette.length - 1; i++) assert.deepEqual(ziele(kette[i])[0], [kette[i + 1]], `${kette[i]} → ${kette[i + 1]}`);
  assert.deepEqual(ziele('Ordner fehlt?'), [['Ordner suchen'], ['Verschieben aufteilen']]);
  assert.deepEqual(ziele('Anlegen?'), [['Ordner anlegen'], ['Ordner planen']]);
  assert.deepEqual(ziele('Anlage auswerten'), [['Ordner planen']]);
  for (const [v, z] of [['Verschieben aufteilen', 'Verschieben'], ['Verschieben', 'Verschiebung auswerten'], ['Verschiebung auswerten', 'Verschoben?'], ['Verschoben?', 'Als gelesen markieren'], ['Als gelesen markieren', 'Ergebnis']]) {
    assert.deepEqual(ziele(v), [[z]], `${v} → ${z}`);
  }

  // Zugangsdaten nur als Namen, nie mit Kennung oder Geheimnis
  for (const n of wf.nodes) for (const c of Object.values(n.credentials ?? {})) assert.equal(c.id, '', `${n.name}: Zugangsdatei mit Kennung`);
  assert.doesNotMatch(roh, /client_secret|Bearer |pk_transport_[A-Za-z0-9]|instanceId|"Authorization"/i);

  // Graph: generische OAuth2-Zugangsdatei wie im Mailversand, Fehler je Element statt Abbruch, keine Wiederholung
  const graphKnoten = ['Mails lesen', 'Anhänge laden', 'Ordner suchen', 'Ordner anlegen', 'Verschieben', 'Als gelesen markieren'];
  for (const name of graphKnoten) {
    const k = knoten(name);
    assert.match(k.parameters.url, /^=https:\/\/graph\.microsoft\.com\/v1\.0\/users\/\{\{ encodeURIComponent\(\$json\.postfach\) \}\}\//, name);
    assert.equal(k.parameters.authentication, 'genericCredentialType');
    assert.equal(k.parameters.genericAuthType, 'oAuth2Api');
    assert.deepEqual(k.credentials, { oAuth2Api: { id: '', name: 'Euroflex Microsoft Graph' } });
    assert.deepEqual(k.parameters.options.response.response, { fullResponse: true, neverError: true });
    assert.equal(k.onError, 'continueRegularOutput');
    assert.notEqual(k.retryOnFail, true);
  }
  const lesen = knoten('Mails lesen').parameters.url as string;
  assert.match(lesen, /\/mailFolders\/\{\{ encodeURIComponent\(\$json\.quellordner\) \}\}\/messages\?/);
  assert.match(lesen, /\$filter=\{\{ encodeURIComponent\('isRead eq false'\) \}\}/);
  assert.match(lesen, /\$top=\{\{ \$json\.max \}\}/);
  for (const feld of ['id', 'internetMessageId', 'subject', 'from', 'toRecipients', 'receivedDateTime', 'body', 'hasAttachments', 'internetMessageHeaders']) {
    assert.ok(lesen.split('$select=')[1].split(',').includes(feld), `$select ohne ${feld}`);
  }
  assert.match(knoten('Anhänge laden').parameters.url, /\/messages\/\{\{ encodeURIComponent\(\$json\.graph_id\) \}\}\/attachments$/);
  assert.equal(knoten('Verschieben').parameters.method, 'POST');
  assert.match(knoten('Verschieben').parameters.url, /\/messages\/\{\{ encodeURIComponent\(\$json\.graph_id\) \}\}\/move$/);
  assert.equal(knoten('Als gelesen markieren').parameters.method, 'PATCH');
  assert.match(knoten('Als gelesen markieren').parameters.url, /\/messages\/\{\{ encodeURIComponent\(\$json\.neue_id\) \}\}$/);
  assert.equal(knoten('Ordner anlegen').parameters.method, 'POST');
  assert.match(knoten('Ordner anlegen').parameters.url, /\/childFolders$/);

  // Portal: Header-Auth-Zugangsdatei, Schlüssel nicht im Workflow
  const p = knoten('An Portal liefern');
  assert.equal(p.parameters.method, 'POST');
  assert.equal(p.parameters.url, 'http://app:8080/api/m/transport/eingang/mail');
  assert.equal(p.parameters.genericAuthType, 'httpHeaderAuth');
  assert.deepEqual(p.credentials, { httpHeaderAuth: { id: '', name: 'Euroflex Portal API-Schlüssel' } });
  assert.equal(p.parameters.sendHeaders, undefined, 'keine eigenen Header – der Schlüssel kommt aus der Zugangsdatei');
  assert.equal(p.onError, 'continueRegularOutput');
  assert.equal(p.parameters.jsonBody, '={{ JSON.stringify($json.payload) }}');
});

test('Konfiguration: ohne Postfach Abbruch mit Hinweis, sonst je Postfach ein Element', () => {
  const roh = knoten('Konfiguration').parameters.jsCode as string;
  assert.throws(() => ausfuehren('Konfiguration', [], {}), /POSTFAECHER/);
  // ältere Fassung: einzelnes POSTFACH
  const einzeln = roh.replace("const POSTFACH = '';", `const POSTFACH = '${POSTFACH}';`);
  assert.deepEqual(ausfuehren('Konfiguration', [], {}, einzeln).map((e) => e.json), [{ postfach: POSTFACH, quellordner: 'Inbox', zielwurzel: 'Inbox', max: 50 }]);
  // mehrere Postfächer (info@ und buchhaltung@): bereinigt, ohne Doppelte, POSTFACH kommt dazu
  const mehrere = roh.replace('const POSTFAECHER = [];', "const POSTFAECHER = [' Info@example.org ', 'buchhaltung@example.org', 'info@example.org'];")
    .replace("const POSTFACH = '';", `const POSTFACH = '${POSTFACH}';`);
  assert.deepEqual(ausfuehren('Konfiguration', [], {}, mehrere).map((e) => e.json.postfach), ['info@example.org', 'buchhaltung@example.org', POSTFACH]);
  assert.throws(() => ausfuehren('Konfiguration', [], {}, roh.replace('const POSTFAECHER = [];', "const POSTFAECHER = ['info@example.org', 'kaputt'];")), /keine gültige Postfach-Adresse: kaputt/);
});

test('Mehrere Postfächer: Mails tragen ihr Postfach, ein gestörtes Postfach hält die anderen nicht auf', () => {
  const INFO = 'info@example.org';
  const aus: Record<string, Element[]> = { Konfiguration: [KONF, { json: { ...KONF.json, postfach: INFO } }] };
  const m = ausfuehren('Mails aufteilen', [{ json: { statusCode: 200, body: { value: [graphMail('B1')] } } }, { json: { statusCode: 200, body: { value: [graphMail('I1'), graphMail('I2')] } } }], aus);
  assert.deepEqual(m.map((e) => [e.json.postfach, e.json.graph_id]), [[POSTFACH, 'B1'], [INFO, 'I1'], [INFO, 'I2']]);
  const teil = ausfuehren('Mails aufteilen', [{ json: { statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } } }, { json: { statusCode: 200, body: { value: [graphMail('I1')] } } }], aus);
  assert.deepEqual(teil.map((e) => e.json.postfach), [INFO]);
  assert.match(teil[0].json.lesefehler[0], /Mails lesen aus auftraege@example\.org\/Inbox fehlgeschlagen \(HTTP 403\)/);
  assert.throws(() => ausfuehren('Mails aufteilen', [{ json: { statusCode: 403, body: {} } }, { json: { statusCode: 200, body: { value: [] } } }], aus), /HTTP 403/);
});

test('Mails lesen abgelehnt: Lauf bricht mit Klartext ab', () => {
  const aus: Record<string, Element[]> = { Konfiguration: [KONF] };
  assert.throws(() => ausfuehren('Mails aufteilen', [{ json: { statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } } }], aus),
    /Mails lesen aus auftraege@example\.org\/Inbox fehlgeschlagen \(HTTP 403\): ErrorAccessDenied.*Mail\.ReadWrite/);
  assert.deepEqual(ausfuehren('Mails aufteilen', [{ json: { statusCode: 200, body: { value: [] } } }], aus), []);
});

test('Für Portal packen: Lieferung laut Vertrag', () => {
  const aus = packen([graphMail('AAMk-1='), graphMail('AAMk-2=', {
    subject: 'Ladenummer 4711', hasAttachments: false, internetMessageHeaders: undefined, internetMessageId: undefined,
    from: { emailAddress: { address: 'dispo@spedition.example' } }, toRecipients: [],
    body: { contentType: 'text', content: 'Bitte Ladenummer 4711 beachten.' },
  })], (id) => (id === 'AAMk-2=' ? { statusCode: 200, body: { value: [] } } : anhaengeOk()));
  const [e1, e2] = aus['Für Portal packen'].map((e) => e.json);
  assert.equal(e1.ok, true);
  assert.equal(e1.fehler, '');
  const p = e1.payload;
  // genau die Felder aus docs/euroflex-mailworkflows.md
  assert.deepEqual(Object.keys(p).sort(), ['an', 'anhaenge', 'betreff', 'datum', 'graph_id', 'html', 'in_reply_to', 'message_id', 'postfach', 'references', 'text', 'von']);
  assert.equal(p.postfach, POSTFACH);
  assert.equal(p.graph_id, 'AAMk-1=');
  assert.equal(p.message_id, '<AAMk-1=@mail.kunde.example>');
  assert.equal(p.in_reply_to, '<m1@example.org>');
  assert.equal(p.references, '<m0@example.org> <m1@example.org>');
  assert.equal(p.von, 'Einkauf Kunde <einkauf@kunde.example>');
  assert.equal(p.an, `Aufträge <${POSTFACH}>, dispo@example.org`);
  assert.equal(p.betreff, 'AW: Lieferschein 2026_0153');
  assert.equal(p.datum, '2026-11-17T06:12:00Z');
  assert.equal(p.text, 'Guten Tag,\nanbei der Scan zu 2026_0153 & die CMR.\nGrüße');
  assert.match(p.html, /^<html>/);
  // nur Dateianhänge, Base64 unverändert, Inline-Bilder gehen mit (das Portal filtert Signaturbilder)
  assert.deepEqual(p.anhaenge.map((a: any) => [a.name, a.mime, Buffer.from(a.inhalt, 'base64').toString()]), [
    ['Scan.pdf', 'application/pdf', '%PDF-1 Scan'], ['logo.png', 'image/png', 'PNG'],
  ]);
  for (const a of p.anhaenge) assert.deepEqual(Object.keys(a).sort(), ['inhalt', 'mime', 'name']);

  // Textmail ohne Kopfzeilen: kein html, leere Verweise, Ersatz-Message-ID aus der Graph-ID
  assert.equal(e2.ok, true);
  assert.equal(e2.payload.html, undefined);
  assert.equal(e2.payload.text, 'Bitte Ladenummer 4711 beachten.');
  assert.equal(e2.payload.in_reply_to, '');
  assert.equal(e2.payload.references, '');
  assert.equal(e2.payload.message_id, '<AAMk-2=@graph.microsoft.com>');
  assert.equal(e2.payload.von, 'dispo@spedition.example');
  assert.equal(e2.payload.an, '');
  assert.deepEqual(e2.payload.anhaenge, []);
  assert.equal(aus['Lieferbar?'].length, 2);
});

test('Für Portal packen: kaputte Mail isoliert, Grenzen des Portals', () => {
  const viele = { statusCode: 200, body: { value: Array.from({ length: 41 }, (_, i) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: `${i}.pdf`, contentType: 'application/pdf', contentBytes: b64('x') })) } };
  const aus = packen([graphMail('A1'), graphMail('A2'), graphMail('A3')], (id) => (
    id === 'A1' ? { statusCode: 404, body: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } }
      : id === 'A2' ? viele : anhaengeOk()));
  const e = aus['Für Portal packen'].map((x) => x.json);
  assert.deepEqual(e.map((x) => x.ok), [false, false, true]);
  assert.match(e[0].fehler, /^Anhänge laden fehlgeschlagen \(HTTP 404\): ErrorItemNotFound/);
  assert.equal(e[0].payload, null);
  assert.match(e[1].fehler, /41 Anhänge – das Portal nimmt höchstens 40/);
  assert.deepEqual(aus['Lieferbar?'].map((x) => x.json.graph_id), ['A3']);
});

test('Antwort auswerten: nur Mails mit aktion.ordner werden verschoben, Pfade normalisiert', () => {
  const aus = packen([graphMail('A1'), graphMail('A2'), graphMail('A3'), graphMail('A4')]);
  aus['An Portal liefern'] = [
    { json: { statusCode: 200, body: { vorgang: 1, status: 'abgelegt', auftragsnr: '2026_0153', aktion: { ordner: 'Portal/Zugeordnet' } } } },
    { json: { statusCode: 200, body: { vorgang: 2, status: 'pruefen', auftragsnr: null, aktion: { ordner: ' Portal\\Prüfen/ ' } } } },
    { json: { statusCode: 200, body: { vorgang: 1, status: 'doppelt', auftragsnr: '2026_0153', aktion: { ordner: 'Portal/Zugeordnet' } } } },
    { json: { statusCode: 500, body: { message: 'Datenbank nicht erreichbar' } } },
  ];
  const s = ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus);
  assert.equal(s.length, 1, 'genau ein Element für die Ordnerschleife');
  const j = s[0].json;
  assert.deepEqual(j.verschieben, [{ postfach: POSTFACH, graph_id: 'A1', pfad: 'Portal/Zugeordnet' }, { postfach: POSTFACH, graph_id: 'A2', pfad: 'Portal/Prüfen' }, { postfach: POSTFACH, graph_id: 'A3', pfad: 'Portal/Zugeordnet' }]);
  assert.deepEqual(j.offen, [`${POSTFACH}|Portal/Zugeordnet`, `${POSTFACH}|Portal/Prüfen`]);
  assert.deepEqual(j.ergebnisse.map((e: any) => e.status), ['abgelegt', 'pruefen', 'doppelt', null]);
  assert.match(j.ergebnisse[3].fehler, /Portal \(HTTP 500\): Datenbank nicht erreichbar/);

  // alles abgewiesen (z. B. Funktion „E-Mail-Eingang über n8n“ aus): Lauf als Fehler sichtbar, nichts wird angefasst
  aus['An Portal liefern'] = aus['An Portal liefern'].map(() => ({ json: { statusCode: 403, body: { message: 'Keine Berechtigung' } } }));
  assert.throws(() => ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus), /Keine Mail an das Portal geliefert.*transport\.eingang:execute/);
  // 200 ohne aktion: Mail bleibt ungelesen liegen
  aus['An Portal liefern'] = aus['An Portal liefern'].map(() => ({ json: { statusCode: 200, body: { vorgang: 3, status: 'pruefen' } } }));
  assert.deepEqual(ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus)[0].json.verschieben, []);
});

test('Ordnerschleife: vorhandene finden, fehlende anlegen, dann verschieben und als gelesen markieren', () => {
  const aus = packen([graphMail('A1'), graphMail('A2'), graphMail('A3')]);
  aus['An Portal liefern'] = [
    { json: { statusCode: 200, body: { vorgang: 1, status: 'abgelegt', auftragsnr: '2026_0153', aktion: { ordner: 'Portal/Zugeordnet' } } } },
    { json: { statusCode: 200, body: { vorgang: 2, status: 'pruefen', auftragsnr: null, aktion: { ordner: 'Portal/Prüfen' } } } },
    { json: { statusCode: 200, body: { vorgang: 3, status: 'ignoriert', auftragsnr: null, aktion: { ordner: 'Portal/Zugeordnet' } } } },
  ];
  aus['Antwort auswerten'] = ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus);
  // „Portal“ und „Portal/Zugeordnet“ gibt es schon (Groß-/Kleinschreibung egal), „Prüfen“ fehlt
  const sim = postfachSimulation({ 'id-portal': { name: 'portal', eltern: 'Inbox' }, 'id-zug': { name: 'Zugeordnet', eltern: 'id-portal' } });
  ordnerAufloesen(aus, sim);
  assert.deepEqual(sim.aufrufe, ['suchen Inbox/Portal', 'suchen id-portal/Zugeordnet', 'suchen id-portal/Prüfen', 'anlegen id-portal/Prüfen']);
  assert.deepEqual(aus['Verschieben aufteilen'].map((e) => e.json), [
    { postfach: POSTFACH, graph_id: 'A1', pfad: 'Portal/Zugeordnet', ziel_id: 'id-zug' },
    { postfach: POSTFACH, graph_id: 'A2', pfad: 'Portal/Prüfen', ziel_id: 'neu-1' },
    { postfach: POSTFACH, graph_id: 'A3', pfad: 'Portal/Zugeordnet', ziel_id: 'id-zug' },
  ]);

  // Verschieben: Graph vergibt eine neue ID; die zweite Mail scheitert und bleibt ungelesen im Posteingang
  aus.Verschieben = [
    { json: { statusCode: 201, body: { id: 'NEU-A1' } } },
    { json: { statusCode: 404, body: { error: { code: 'ErrorItemNotFound', message: 'not found' } } } },
    { json: { statusCode: 201, body: { id: 'NEU-A3' } } },
  ];
  aus['Verschiebung auswerten'] = ausfuehren('Verschiebung auswerten', aus.Verschieben, aus);
  assert.deepEqual(aus['Verschiebung auswerten'].map((e) => [e.json.ok, e.json.neue_id]), [[true, 'NEU-A1'], [false, null], [true, 'NEU-A3']]);
  assert.match(aus['Verschiebung auswerten'][1].json.fehler, /Verschieben nach „Portal\/Prüfen“ fehlgeschlagen \(HTTP 404\)/);
  aus['Verschoben?'] = aus['Verschiebung auswerten'].filter((e) => e.json.ok === true);
  aus['Als gelesen markieren'] = [{ json: { statusCode: 200, body: { id: 'NEU-A1', isRead: true } } }, { json: { statusCode: 200, body: { id: 'NEU-A3', isRead: true } } }];
  const r = ausfuehren('Ergebnis', aus['Als gelesen markieren'], aus)[0].json;
  assert.equal(r.geliefert, 3);
  assert.equal(r.verschoben, 2);
  assert.equal(r.als_gelesen, 2);
  assert.deepEqual(r.status, { abgelegt: 1, pruefen: 1, ignoriert: 1 });
  assert.equal(r.fehler.length, 1);
});

test('Ordnerschleife: leeres Postfach legt den ganzen Pfad an; Fehler beim Suchen geben nur diesen Pfad auf', () => {
  const aus = packen([graphMail('A1'), graphMail('A2')]);
  aus['An Portal liefern'] = [
    { json: { statusCode: 200, body: { vorgang: 1, status: 'abgelegt', auftragsnr: '2026_0153', aktion: { ordner: 'Portal/Zugeordnet' } } } },
    { json: { statusCode: 200, body: { vorgang: 2, status: 'pruefen', auftragsnr: null, aktion: { ordner: "Kunde's Ordner" } } } },
  ];
  aus['Antwort auswerten'] = ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus);
  let sim = postfachSimulation({});
  ordnerAufloesen(aus, sim);
  assert.deepEqual(sim.aufrufe, ['suchen Inbox/Portal', 'anlegen Inbox/Portal', 'suchen neu-1/Zugeordnet', 'anlegen neu-1/Zugeordnet', "suchen Inbox/Kunde's Ordner", "anlegen Inbox/Kunde's Ordner"]);
  assert.deepEqual(aus['Verschieben aufteilen'].map((e) => e.json.ziel_id), ['neu-2', 'neu-3']);
  assert.deepEqual(aus['Ordner planen'][0].json.angelegt, ['Portal', 'Portal/Zugeordnet', "Kunde's Ordner"].map((x) => `${POSTFACH}|${x}`));

  // Suche nach „Portal“ abgelehnt → Pfad aufgegeben, die andere Mail wird trotzdem verschoben
  sim = postfachSimulation({}, (art, name) => (art === 'suchen' && name === 'Portal' ? { statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } } : null));
  ordnerAufloesen(aus, sim);
  assert.deepEqual(aus['Verschieben aufteilen'].map((e) => e.json.graph_id), ['A2']);
  assert.match(aus['Ordner planen'][0].json.fehler[`${POSTFACH}|Portal/Zugeordnet`], /Ordner „Portal“ suchen fehlgeschlagen \(HTTP 403\)/);

  // Anlegen abgelehnt → ebenso
  sim = postfachSimulation({}, (art) => (art === 'anlegen' ? { statusCode: 409, body: { error: { code: 'ErrorFolderExists', message: 'exists' } } } : null));
  ordnerAufloesen(aus, sim);
  assert.deepEqual(aus['Verschieben aufteilen'], []);
  assert.equal(Object.keys(aus['Ordner planen'][0].json.fehler).length, 2);
});

test('Ordner suchen: Name mit Hochkomma wird für $filter verdoppelt', () => {
  const url = knoten('Ordner suchen').parameters.url as string;
  const ausdruck = /\$filter=\{\{ (.+?) \}\}&/.exec(url)?.[1];
  assert.ok(ausdruck);
  const $json = { schritt: { name: "Kunde's Ordner" } };
  const wert = new Function('$json', `return ${ausdruck};`)($json) as string;
  assert.equal(decodeURIComponent(wert), "displayName eq 'Kunde''s Ordner'");
});

test('Ordnerschleife mit zwei Postfächern: Ordner je Postfach getrennt aufgelöst und verschoben', () => {
  const INFO = 'info@example.org';
  const aus = packen([graphMail('A1'), graphMail('A2')]);
  aus['Lieferbar?'][1].json.postfach = INFO;
  aus['An Portal liefern'] = [
    { json: { statusCode: 200, body: { vorgang: 1, status: 'abgelegt', auftragsnr: '2026_0153', aktion: { ordner: 'Portal/Zugeordnet' } } } },
    { json: { statusCode: 200, body: { vorgang: 2, status: 'abgelegt', auftragsnr: '2026_0154', aktion: { ordner: 'Portal/Zugeordnet' } } } },
  ];
  aus['Antwort auswerten'] = ausfuehren('Antwort auswerten', aus['An Portal liefern'], aus);
  assert.deepEqual(aus['Antwort auswerten'][0].json.offen, [`${POSTFACH}|Portal/Zugeordnet`, `${INFO}|Portal/Zugeordnet`]);
  // je Postfach eigene Ordner: der Simulation wird das Postfach des Schritts mitgegeben
  const sims: Record<string, ReturnType<typeof postfachSimulation>> = { [POSTFACH]: postfachSimulation({}), [INFO]: postfachSimulation({}) };
  let eingang = aus['Antwort auswerten'];
  for (let runde = 0; runde < 50; runde++) {
    aus['Ordner planen'] = ausfuehren('Ordner planen', eingang, aus);
    const st = aus['Ordner planen'][0].json;
    if (st.schritt === null) break;
    assert.equal(st.postfach, st.schritt.postfach, 'Graph-Adresse des Schritts');
    aus['Ordner suchen'] = [{ json: sims[st.postfach].suchen(st.schritt.eltern, st.schritt.name) }];
    aus['Suche auswerten'] = ausfuehren('Suche auswerten', aus['Ordner suchen'], aus);
    const su = aus['Suche auswerten'][0].json;
    if (su.anlegen === true) {
      aus['Ordner anlegen'] = [{ json: sims[su.postfach].anlegen(su.schritt.eltern, su.schritt.name) }];
      aus['Anlage auswerten'] = ausfuehren('Anlage auswerten', aus['Ordner anlegen'], aus);
      eingang = aus['Anlage auswerten'];
    } else eingang = su.schritt ? aus['Suche auswerten'] : eingang;
  }
  aus['Verschieben aufteilen'] = ausfuehren('Verschieben aufteilen', aus['Ordner planen'], aus);
  assert.deepEqual(sims[POSTFACH].aufrufe, ['suchen Inbox/Portal', 'anlegen Inbox/Portal', 'suchen neu-1/Zugeordnet', 'anlegen neu-1/Zugeordnet']);
  assert.deepEqual(sims[INFO].aufrufe, sims[POSTFACH].aufrufe);
  assert.deepEqual(aus['Verschieben aufteilen'].map((e) => [e.json.postfach, e.json.graph_id, e.json.ziel_id]), [[POSTFACH, 'A1', 'neu-2'], [INFO, 'A2', 'neu-2']]);
});
