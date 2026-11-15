import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { entschluesseln, pushDienstErlaubt, vapidKopf, vapidSchluesselErzeugen, verschluesseln } from '../src/lib/webpush.js';

test('Verschlüsselung: Beispiel aus RFC 8291 (Anhang A) Byte für Byte', () => {
  const geraet = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const rumpf = verschluesseln('When I grow up, I want to be a watermelon', geraet, {
    salz: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), privat: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
  });
  assert.equal(rumpf.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.equal(entschluesseln(rumpf, { ...geraet, privat: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94' }).toString(), 'When I grow up, I want to be a watermelon');
});

test('Verschlüsselung: jedes Mal anders, nur das Gerät kann lesen (auch Umlaute)', () => {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const g = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), privat: ecdh.getPrivateKey().toString('base64url') };
  const text = JSON.stringify({ titel: 'Neue Veranstaltung', text: 'Sommerfest für Groß und Klein' });
  const a = verschluesseln(text, g), b = verschluesseln(text, g);
  assert.notDeepEqual(a, b);
  assert.equal(entschluesseln(a, g).toString(), text);
  assert.throws(() => entschluesseln(a, { ...g, auth: crypto.randomBytes(16).toString('base64url') }));
  assert.throws(() => verschluesseln('x', { p256dh: 'AAAA', auth: g.auth }), /Geräteschlüssel/);
});

test('VAPID: Ausweis ist mit dem öffentlichen Schlüssel prüfbar und gilt nur für den Push-Dienst', () => {
  const k = vapidSchluesselErzeugen();
  const kopf = vapidKopf('https://fcm.googleapis.com/fcm/send/abc', k, 'mailto:portal@example.org', Date.UTC(2026, 0, 1));
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(kopf)!;
  assert.equal(m[4], k.oeffentlich);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(m[2], 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: Date.UTC(2026, 0, 1) / 1000 + 43200, sub: 'mailto:portal@example.org' });
  const p = Buffer.from(k.oeffentlich, 'base64url');
  const pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: p.subarray(1, 33).toString('base64url'), y: p.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('Push-Dienste: nur die bekannten Dienste über https – keine Adressen im eigenen Netz', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-db5p.notify.windows.com/w/?token=x']) assert.ok(pushDienstErlaubt(ok), ok);
  for (const nein of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://192.168.1.1/x', 'https://googleapis.com.evil.example/x', 'https://evilgoogleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://a@fcm.googleapis.com/x', 'kein-link']) assert.ok(!pushDienstErlaubt(nein), nein);
});
