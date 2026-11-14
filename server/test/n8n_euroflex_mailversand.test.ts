/**
 * n8n-Workflow „Euroflex Mailversand“ (docs/n8n/euroflex-mailversand.json, #235) – ohne n8n und ohne Datenbank:
 * Aufbau der Datei (Knoten, Verbindungen, keine Zugangsdaten) und die Logik der Code-Knoten mit nachgestellten
 * Antworten von Microsoft Graph. Der Versand selbst lässt sich nur in n8n gegen ein echtes Postfach prüfen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

interface Knoten { name: string; type: string; parameters: Record<string, any>; credentials?: Record<string, { id: string; name: string }>; onError?: string }
const datei = fileURLToPath(new URL('../../docs/n8n/euroflex-mailversand.json', import.meta.url));
const wf = JSON.parse(fs.readFileSync(datei, 'utf8')) as { name: string; nodes: Knoten[]; connections: Record<string, { main: { node: string }[][] }> };
const knoten = (name: string) => { const k = wf.nodes.find((n) => n.name === name); assert.ok(k, `Knoten ${name} fehlt`); return k; };

type Element = { json: Record<string, any> };
/** Code-Knoten ausführen: $input = Eingang, $('Name') = Ausgang eines früheren Knotens */
function ausfuehren(name: string, eingang: Element[], bisher: Record<string, Element[]>): Element[] {
  const $ = (n: string) => {
    if (!(n in bisher)) throw new Error(`Knoten ${n} wurde nicht ausgeführt`);
    return { first: () => bisher[n][0], all: () => bisher[n] };
  };
  const f = new Function('$input', '$', knoten(name).parameters.jsCode as string);
  return f({ first: () => eingang[0], all: () => eingang }, $) as Element[];
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const aufruf = (extra: Record<string, unknown> = {}) => ({
  modus: 'senden', anwendung: 'Euroflex', objekt: '2026_0153', benutzer: 'Test', absender: 'dispo@example.org',
  anhaenge: [
    { id: 'a1', dateiname: 'Lieferschein_2026_0153.pdf', mime: 'application/pdf', inhalt_base64: b64('%PDF-1 Lieferschein') },
    { id: 'a2', dateiname: 'CMR.pdf', mime: 'application/pdf', inhalt_base64: b64('%PDF-1 CMR') },
  ],
  mails: [
    { nr: 1, rolle: 'kunde', an: ['kunde@example.org'], cc: ['Einkauf <einkauf@example.org>'], betreff: 'Lieferschein 2026_0153', text: 'Guten Tag', text_format: 'text', anhaenge: ['a1', 'a2'] },
    { nr: 2, rolle: 'kopie', an: ['ablage@example.org'], betreff: 'Lieferschein 2026_0153', text: 'Guten Tag', text_format: 'text', anhaenge: ['a1', 'a2'] },
  ],
  ...extra,
});

/** Ablauf wie in n8n: prüfen → aufteilen → Entwurf anlegen (Graph) → auswerten → ggf. senden (Graph) → Ergebnis */
function lauf(body: Record<string, unknown>, graph: { entwurf: (nr: number) => Record<string, any>; senden?: (nr: number) => Record<string, any> }) {
  const aus: Record<string, Element[]> = { 'Webhook Portal': [{ json: { body } }] };
  aus['Aufruf prüfen'] = ausfuehren('Aufruf prüfen', aus['Webhook Portal'], aus);
  const p = aus['Aufruf prüfen'][0].json;
  if (!p.ok) return { gueltig: false, fehler: p.fehler as string, antwort: {} as Record<string, any>, aus };
  aus['E-Mails aufteilen'] = ausfuehren('E-Mails aufteilen', aus['Aufruf prüfen'], aus);
  aus['Entwurf anlegen'] = aus['E-Mails aufteilen'].map((m) => ({ json: graph.entwurf(m.json.nr) }));
  aus['Entwürfe auswerten'] = ausfuehren('Entwürfe auswerten', aus['Entwurf anlegen'], aus);
  assert.equal(aus['Entwürfe auswerten'].length, 1, 'genau ein Element – sonst liefe der Versand mehrfach');
  let eingang = aus['Entwürfe auswerten'];
  if (aus['Entwürfe auswerten'][0].json.sendbar > 0) {
    aus['Sendbare aufteilen'] = ausfuehren('Sendbare aufteilen', aus['Entwürfe auswerten'], aus);
    aus.Senden = aus['Sendbare aufteilen'].map((m) => ({ json: (graph.senden ?? ((_nr: number) => ({ statusCode: 202, body: '' })))(m.json.nr) }));
    eingang = aus.Senden;
  }
  aus.Ergebnis = ausfuehren('Ergebnis', eingang, aus);
  assert.equal(aus.Ergebnis.length, 1);
  return { gueltig: true, fehler: '', antwort: aus.Ergebnis[0].json.antwort as Record<string, any>, aus };
}
const entwurfOk = (nr: number) => ({ statusCode: 201, body: { id: `AAMk-${nr}=`, internetMessageId: `<m${nr}@example.org>` } });

test('Workflow-Datei: Knoten, Verbindungen, keine Zugangsdaten', () => {
  assert.equal(wf.name, 'Euroflex Mailversand');
  const namen = wf.nodes.map((n) => n.name);
  assert.equal(new Set(namen).size, namen.length, 'Knotennamen eindeutig');
  for (const [von, c] of Object.entries(wf.connections)) {
    assert.ok(namen.includes(von), `Verbindung ab unbekanntem Knoten ${von}`);
    for (const ziel of c.main.flat()) assert.ok(namen.includes(ziel.node), `Verbindung zu unbekanntem Knoten ${ziel.node}`);
  }
  // jeder Knoten außer Webhook und Hinweis hat einen Eingang; jeder Weg endet in einer Antwort an das Portal
  const ziele = new Set(Object.values(wf.connections).flatMap((c) => c.main.flat().map((z) => z.node)));
  for (const n of wf.nodes) if (!['Webhook Portal', 'Hinweis'].includes(n.name)) assert.ok(ziele.has(n.name), `${n.name} hat keinen Eingang`);
  for (const n of wf.nodes) {
    const ende = !wf.connections[n.name];
    if (ende && n.name !== 'Hinweis') assert.equal(n.type, 'n8n-nodes-base.respondToWebhook', `${n.name} endet ohne Antwort`);
  }
  // Zugangsdaten nur als Namen, nie mit Kennung oder Geheimnis
  for (const n of wf.nodes) for (const c of Object.values(n.credentials ?? {})) assert.equal(c.id, '', `${n.name}: Zugangsdatei mit Kennung`);
  assert.doesNotMatch(fs.readFileSync(datei, 'utf8'), /client_secret|Bearer |instanceId/i);
  // Webhook: Schlüssel im Header, Antwort erst durch den Antwort-Knoten
  const w = knoten('Webhook Portal');
  assert.equal(w.parameters.path, 'euroflex-mailversand');
  assert.equal(w.parameters.authentication, 'headerAuth');
  assert.equal(w.parameters.responseMode, 'responseNode');
  // Graph-Aufrufe: aus dem Postfach des Absenders, Fehler als Antwort statt Abbruch, keine automatische Wiederholung (sonst doppelte E-Mails)
  for (const name of ['Postfach prüfen', 'Entwurf anlegen', 'Senden']) {
    const k = knoten(name) as Knoten & { retryOnFail?: boolean };
    assert.match(k.parameters.url, /^=https:\/\/graph\.microsoft\.com\/v1\.0\/users\/\{\{ encodeURIComponent\(\$json\.absender\) \}\}\//);
    assert.equal(k.parameters.genericAuthType, 'oAuth2Api');
    assert.deepEqual(k.parameters.options.response.response, { fullResponse: true, neverError: true });
    assert.equal(k.onError, 'continueRegularOutput');
    assert.notEqual(k.retryOnFail, true);
  }
  // „Ergebnis“ hat zwei Eingänge, die sich ausschließen (Etwas zu senden? → nein | Senden)
  const nachErgebnis = Object.entries(wf.connections).filter(([, c]) => c.main.flat().some((z) => z.node === 'Ergebnis')).map(([v]) => v).sort();
  assert.deepEqual(nachErgebnis, ['Etwas zu senden?', 'Senden']);
});

test('Zwei E-Mails mit gemeinsamen Anhängen: beide gesendet', () => {
  const r = lauf(aufruf(), { entwurf: entwurfOk });
  assert.equal(r.gueltig, true);
  const mails = r.aus['E-Mails aufteilen'];
  assert.equal(mails.length, 2);
  const n1 = mails[0].json.nachricht;
  assert.deepEqual(n1.toRecipients, [{ emailAddress: { address: 'kunde@example.org' } }]);
  assert.deepEqual(n1.ccRecipients, [{ emailAddress: { address: 'einkauf@example.org', name: 'Einkauf' } }]);
  assert.deepEqual(n1.body, { contentType: 'Text', content: 'Guten Tag' });
  assert.deepEqual(n1.attachments.map((a: any) => [a['@odata.type'], a.name, a.contentType, Buffer.from(a.contentBytes, 'base64').toString()]), [
    ['#microsoft.graph.fileAttachment', 'Lieferschein_2026_0153.pdf', 'application/pdf', '%PDF-1 Lieferschein'],
    ['#microsoft.graph.fileAttachment', 'CMR.pdf', 'application/pdf', '%PDF-1 CMR'],
  ]);
  assert.deepEqual(mails[1].json.nachricht.toRecipients, [{ emailAddress: { address: 'ablage@example.org' } }]);
  assert.equal(mails[1].json.nachricht.attachments.length, 2);
  assert.deepEqual(r.aus['Sendbare aufteilen'].map((m) => m.json), [
    { nr: 1, absender: 'dispo@example.org', entwurf_id: 'AAMk-1=' }, { nr: 2, absender: 'dispo@example.org', entwurf_id: 'AAMk-2=' },
  ]);
  assert.equal(r.antwort.status, 'gesendet');
  assert.equal(r.antwort.postfach, 'dispo@example.org');
  assert.deepEqual(r.antwort.mails.map((m: any) => [m.nr, m.rolle, m.an, m.status, m.message_id]), [
    [1, 'kunde', 'kunde@example.org', 'gesendet', '<m1@example.org>'], [2, 'kopie', 'ablage@example.org', 'gesendet', '<m2@example.org>'],
  ]);
});

test('Teilerfolg: Entwurf der zweiten E-Mail abgelehnt – die erste geht trotzdem hinaus', () => {
  const r = lauf(aufruf(), {
    entwurf: (nr) => (nr === 2 ? { statusCode: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } } : entwurfOk(nr)),
  });
  assert.equal(r.gueltig, true);
  assert.deepEqual(r.aus['Sendbare aufteilen'].map((m) => m.json.nr), [1]);
  assert.equal(r.antwort.status, 'teilweise');
  assert.equal(r.antwort.mails[0].status, 'gesendet');
  assert.equal(r.antwort.mails[1].status, 'fehler');
  assert.match(r.antwort.mails[1].fehler, /Entwurf anlegen fehlgeschlagen \(HTTP 403\): ErrorAccessDenied: Access is denied\..*darf dieses Postfach nicht verwenden/);
  assert.match(r.antwort.fehler, /^E-Mail 2: /);
});

test('Senden abgelehnt: Fehler mit Hinweis auf den Entwurf; alles abgelehnt: Status fehler ohne Sendeversuch', () => {
  let r = lauf(aufruf(), { entwurf: entwurfOk, senden: (nr) => (nr === 1 ? { statusCode: 202, body: '' } : { error: 'socket hang up' }) });
  assert.equal(r.gueltig, true);
  assert.equal(r.antwort.status, 'teilweise');
  assert.equal(r.antwort.mails[1].entwurf_im_postfach, true);
  assert.match(r.antwort.mails[1].fehler, /Senden fehlgeschlagen: socket hang up Der Entwurf liegt im Postfach/);

  r = lauf(aufruf(), { entwurf: () => ({ statusCode: 404, body: { error: { code: 'ErrorInvalidUser', message: 'The requested user is invalid.' } } }) });
  assert.equal(r.gueltig, true);
  assert.equal(r.aus['Entwürfe auswerten'][0].json.sendbar, 0);
  assert.equal(r.aus.Senden, undefined);
  assert.equal(r.antwort.status, 'fehler');
  assert.match(r.antwort.mails[0].fehler, /HTTP 404.*Postfach gibt es in Microsoft 365 nicht/);
});

test('Modus entwurf: Entwürfe angelegt, nichts gesendet', () => {
  const r = lauf(aufruf({ modus: 'entwurf' }), { entwurf: entwurfOk, senden: () => { throw new Error('darf nicht senden'); } });
  assert.equal(r.gueltig, true);
  assert.equal(r.aus['Entwürfe auswerten'][0].json.sendbar, 0);
  assert.equal(r.antwort.status, 'entwurf');
  assert.deepEqual(r.antwort.mails.map((m: any) => m.status), ['entwurf', 'entwurf']);
});

test('Ungültige Aufrufe werden abgelehnt, bevor etwas angelegt wird', () => {
  const falsch = (extra: Record<string, unknown>, muster: RegExp) => {
    const r = lauf(aufruf(extra), { entwurf: () => { throw new Error('darf nichts anlegen'); } });
    assert.equal(r.gueltig, false);
    assert.match(r.fehler, muster);
  };
  falsch({ absender: '' }, /Absender-Postfach fehlt/);
  falsch({ absender: 'kein postfach' }, /keine gültige Adresse/);
  falsch({ modus: 'loeschen' }, /Unbekannter Modus/);
  falsch({ mails: [] }, /enthält keine E-Mail/);
  falsch({ mails: [{ nr: 1, an: ['kunde@example.org'], betreff: 'x', anhaenge: ['a9'] }] }, /unbekannter Anhang „a9“/);
  falsch({ mails: [{ nr: 1, an: ['kunde(at)example.org'], betreff: 'x' }] }, /ungültige Adresse.*kein Empfänger/);
  falsch({ mails: [{ nr: 1, an: 'kunde@example.org', betreff: '' }] }, /Betreff fehlt/);
  falsch({ mails: [{ nr: 1, an: 'a@example.org', betreff: 'x' }, { nr: 1, an: 'b@example.org', betreff: 'x' }] }, /nicht eindeutig/);
  falsch({ anhaenge: [{ id: 'a1', dateiname: 'leer.pdf', inhalt_base64: '' }], mails: [{ nr: 1, an: 'a@example.org', betreff: 'x' }] }, /„leer\.pdf“ ist leer/);
  falsch({ anhaenge: [{ id: 'a1', dateiname: 'x.pdf', inhalt_base64: 'QQ==' }, { id: 'a1', dateiname: 'y.pdf', inhalt_base64: 'QQ==' }] }, /„a1“ ist doppelt/);
});

test('Modus pruefen: ohne E-Mails gültig, mit und ohne Postfach', () => {
  const pruefen = (body: Record<string, unknown>) => ausfuehren('Aufruf prüfen', [{ json: { body } }], {})[0].json;
  let p = pruefen({ modus: 'pruefen', absender: 'dispo@example.org' });
  assert.equal(p.ok, true);
  assert.equal(p.postfach_pruefen, true);
  p = pruefen({ modus: 'pruefen', absender: '' });
  assert.equal(p.ok, true);
  assert.equal(p.postfach_pruefen, false);
  // Empfänger als Text mit Komma/Semikolon
  p = pruefen(aufruf({ mails: [{ an: 'a@example.org; B Beispiel <b@example.org>', betreff: 'x' }] }));
  assert.equal(p.ok, true);
  assert.deepEqual(p.mails[0].an, [{ emailAddress: { address: 'a@example.org' } }, { emailAddress: { address: 'b@example.org', name: 'B Beispiel' } }]);
  assert.equal(p.mails[0].nr, 1);
});
