import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ausgehendMehrere, FREIGABE_ADRESSE_FEHLT, nurIntern, Paperless } from '../src/lib/paperless.js';

/**
 * Freigabelinks gehen an Empfänger außerhalb des eigenen Netzes (Rechnungsversand per E-Mail/WhatsApp):
 * Sie dürfen nicht mit der LAN-Adresse gebildet werden, über die der Server Paperless erreicht.
 */
test('nurIntern: LAN-, Loopback- und Containeradressen', () => {
  for (const u of ['http://192.168.178.105:8010', 'http://10.0.0.5', 'http://172.20.1.1:8000', 'http://127.0.0.1:8000', 'http://localhost:8000',
    'http://paperless:8000', 'http://nas.fritz.box:8000', 'http://server.local', 'http://[::1]:8000', 'http://100.101.1.2:8000', 'kein-url']) {
    assert.equal(nurIntern(u), true, u);
  }
  for (const u of ['https://dokumente.example.org', 'https://ngx.verein.de/paperless', 'http://172.32.0.1', 'http://8.8.8.8:8000']) {
    assert.equal(nurIntern(u), false, u);
  }
});

test('Freigabelink: eingestellte Adresse, sonst erste öffentliche Basis-URL, sonst Basis-URL des Servers', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (s: number, d: unknown) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (req.url === '/api/') return send(200, {});
      if (req.url === '/api/documents/7/share_links/') return send(200, [{ slug: 'alt', created: '2026-01-01T10:00:00Z', expiration: null }]);
      if (req.url === '/api/documents/8/share_links/') return send(200, []);
      if (req.url === '/api/share_links/') return send(201, { slug: `neu${JSON.parse(body).document}` });
      send(404, {});
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const lan = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    // nur LAN-Adresse: wie bisher
    let pl = new Paperless({ url: lan, token: 't' });
    assert.equal(await pl.freigabelink(7), `${lan}/share/alt`);
    assert.equal(await pl.freigabelink(8), `${lan}/share/neu8`);
    // Adresse für Freigabelinks: API weiter über das LAN, Link mit der öffentlichen Adresse – auch für vorhandene Links
    pl = new Paperless({ url: lan, token: 't', freigabeUrl: ' https://dokumente.example.org/ ' });
    assert.equal(await pl.baseUrl(), lan);
    assert.equal(await pl.freigabelink(7), 'https://dokumente.example.org/share/alt');
    assert.equal(await pl.freigabelinkAnlegen(8), 'https://dokumente.example.org/share/neu8');
    assert.deepEqual(await pl.freigabelinks(7), ['https://dokumente.example.org/share/alt']);
    // ohne Einstellung: der Link nimmt die Internet-Adresse, die Ablage die interne – unabhängig von der Reihenfolge der Eingabe
    pl = new Paperless({ url: `${lan},https://extern.example.org`, token: 't' });
    assert.equal(await pl.baseUrl(), lan);
    assert.equal(await pl.freigabelink(7), 'https://extern.example.org/share/alt');
    pl = new Paperless({ url: `https://extern.example.org, ${lan}/`, token: 't2' });
    assert.equal(await pl.baseUrl(), lan, 'Ablage: intern zuerst');
    assert.equal(pl.freigabeExtern(), 'https://extern.example.org');
    // die Einstellung geht vor
    pl = new Paperless({ url: `${lan},https://extern.example.org`, token: 't', freigabeUrl: 'https://dokumente.example.org' });
    assert.equal(await pl.freigabelink(8), 'https://dokumente.example.org/share/neu8');
  } finally {
    srv.close();
  }
});

test('Ausgehende Texte: Freigabelinks immer mit der externen Adresse, sonst Ablehnung', () => {
  const lan = 'http://192.168.178.105:8010';
  const text = `Hallo Tina,\n\nRechnung 2026_090 (12,00 €): ${lan}/share/e1gl4DDqIQPmEYizYQwMl6xb\n\nViele Grüße`;
  // Adresse für Freigabelinks eingetragen: Link wird umgeschrieben, der Rest bleibt
  let pl = new Paperless({ url: lan, token: 't', freigabeUrl: 'https://dokumente.example.org' });
  assert.equal(pl.ausgehend(text), text.replace(lan, 'https://dokumente.example.org'));
  assert.equal(pl.ausgehend(pl.ausgehend(text)), pl.ausgehend(text), 'bereits externe Links bleiben');
  // HTML, mehrere Links, andere interne Adresse (früherer Stand der Anbindung), fremde öffentliche Links bleiben
  const html = `<a href="${lan}/share/abc_1-2">Rechnung</a> (http://paperless:8000/share/xyz) https://cloud.example.com/share/fremd ${lan}/documents/5/details`;
  assert.equal(pl.ausgehend(html),
    `<a href="https://dokumente.example.org/share/abc_1-2">Rechnung</a> (https://dokumente.example.org/share/xyz) https://cloud.example.com/share/fremd ${lan}/documents/5/details`);
  // zweite, öffentliche Basis-URL ohne eigene Einstellung
  pl = new Paperless({ url: `${lan},https://extern.example.org`, token: 't' });
  assert.equal(pl.ausgehend(`${lan}/share/a1`), 'https://extern.example.org/share/a1');
  assert.equal(pl.freigabeExternPflicht(), 'https://extern.example.org');
  // nur interne Adresse: nichts geht mit internem Link hinaus; Texte ohne Freigabelink sind nicht betroffen
  pl = new Paperless({ url: lan, token: 't' });
  assert.equal(pl.freigabeExtern(), null);
  assert.throws(() => pl.ausgehend(text), (e: Error) => e.message === FREIGABE_ADRESSE_FEHLT);
  assert.throws(() => pl.freigabeExternPflicht(), /Adresse für Freigabelinks/);
  assert.equal(pl.ausgehend('Hallo, bitte überweise den Betrag.'), 'Hallo, bitte überweise den Betrag.');
  // reiner LAN-Betrieb: interne Adresse bewusst als Adresse für Freigabelinks eingetragen
  pl = new Paperless({ url: 'http://paperless:8000', token: 't', freigabeUrl: lan });
  assert.equal(pl.ausgehend(`http://paperless:8000/share/a1 ${lan}/share/a2`), `${lan}/share/a1 ${lan}/share/a2`);
});

test('Ausgehende Texte bei einem Paperless je Bereich (#232, S5): jeder Link mit dem Zugang seines Bereichs', () => {
  const verein = new Paperless({ url: 'http://paperless:8000,https://dokumente.verein.example', token: 't' });
  const euroflex = new Paperless({ url: 'http://paperless-euroflex:8000', token: 't', freigabeUrl: 'https://dokumente.euroflex.example' });
  const beide = [verein, euroflex];
  // interne Adressen werden je Bereich auf dessen externe umgeschrieben – nie auf die des anderen
  assert.equal(ausgehendMehrere('Verein http://paperless:8000/share/v1 und Euroflex http://paperless-euroflex:8000/share/e1', beide),
    'Verein https://dokumente.verein.example/share/v1 und Euroflex https://dokumente.euroflex.example/share/e1');
  assert.equal(ausgehendMehrere('http://paperless-euroflex:8000/share/e1', [euroflex, verein]), 'https://dokumente.euroflex.example/share/e1', 'unabhängig von der Reihenfolge');
  // bereits externe Links und fremde öffentliche Links bleiben
  const fertig = 'https://dokumente.euroflex.example/share/e1 https://dokumente.verein.example/share/v1 https://anderswo.example.org/share/x';
  assert.equal(ausgehendMehrere(fertig, beide), fertig);
  assert.equal(ausgehendMehrere('Ohne Link.', beide), 'Ohne Link.');
  // interne Adresse, die zu keinem Zugang gehört: abgelehnt statt geraten
  assert.throws(() => ausgehendMehrere('http://192.168.1.50:8000/share/a1', beide), /gehört zu keinem eingerichteten Paperless/);
  // Bereich ohne externe Adresse: abgelehnt wie bisher
  const ohne = new Paperless({ url: 'http://paperless-neu:8000', token: 't' });
  assert.throws(() => ausgehendMehrere('http://paperless-neu:8000/share/a1', [verein, ohne]), (e: Error) => e.message === FREIGABE_ADRESSE_FEHLT);
  // ein einziger Zugang oder keiner: wie bisher
  assert.equal(ausgehendMehrere('http://192.168.1.50:8000/share/a1', [euroflex]), 'https://dokumente.euroflex.example/share/a1');
  assert.equal(ausgehendMehrere('http://192.168.1.50:8000/share/a1', []), 'http://192.168.1.50:8000/share/a1');
  // kennt(): Adressen für die Ablage und für Freigabelinks
  assert.deepEqual([verein.kennt('http://paperless:8000'), verein.kennt('https://dokumente.verein.example'), verein.kennt('http://paperless-euroflex:8000'), euroflex.kennt('https://dokumente.euroflex.example')],
    [true, true, false, true]);
});
