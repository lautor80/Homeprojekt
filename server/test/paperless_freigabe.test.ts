import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { nurIntern, Paperless } from '../src/lib/paperless.js';

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
    // ohne Einstellung: „erst LAN, dann Internet“ – der Link nimmt die Internet-Adresse, die API die erreichbare LAN-Adresse
    pl = new Paperless({ url: `${lan},https://extern.example.org`, token: 't' });
    assert.equal(await pl.baseUrl(), lan);
    assert.equal(await pl.freigabelink(7), 'https://extern.example.org/share/alt');
    // die Einstellung geht vor
    pl = new Paperless({ url: `${lan},https://extern.example.org`, token: 't', freigabeUrl: 'https://dokumente.example.org' });
    assert.equal(await pl.freigabelink(8), 'https://dokumente.example.org/share/neu8');
  } finally {
    srv.close();
  }
});
