/**
 * Web-Push ohne Fremdbibliothek: Nachricht für ein Gerät verschlüsseln (RFC 8291, „aes128gcm“ nach RFC 8188) und den
 * Absender gegenüber dem Push-Dienst ausweisen (VAPID, RFC 8292). Reine Rechnung mit node:crypto – kein Netz, keine
 * Datenbank; Versand und Geräteverwaltung stehen in push.ts.
 *
 * Schlüssel und Geräteangaben sind base64url-kodiert, so wie der Browser sie liefert (PushSubscription.toJSON()).
 */
import crypto from 'node:crypto';

const b64 = (b: Buffer): string => b.toString('base64url');
const roh = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Schlüsselpaar des Portals: `oeffentlich` (65 Byte, unkomprimierter Punkt) bekommt der Browser, `privat` bleibt am Server */
export interface VapidSchluessel { oeffentlich: string; privat: string }

export function vapidSchluesselErzeugen(): VapidSchluessel {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { oeffentlich: b64(ecdh.getPublicKey()), privat: b64(ecdh.getPrivateKey()) };
}

function privatSchluessel(k: VapidSchluessel): crypto.KeyObject {
  const p = roh(k.oeffentlich);
  if (p.length !== 65 || p[0] !== 4) throw new Error('VAPID-Schlüssel ungültig');
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64(p.subarray(1, 33)), y: b64(p.subarray(33)), d: k.privat } });
}

/**
 * Kopfzeile „Authorization“ für den Push-Dienst: signierter Ausweis (ES256), gültig für genau diesen Dienst (aud).
 * `kontakt` ist eine mailto:- oder https-Adresse, unter der der Dienst den Betreiber erreicht.
 */
export function vapidKopf(endpoint: string, k: VapidSchluessel, kontakt: string, jetzt = Date.now()): string {
  const teil = (o: object) => b64(Buffer.from(JSON.stringify(o)));
  const text = `${teil({ typ: 'JWT', alg: 'ES256' })}.${teil({ aud: new URL(endpoint).origin, exp: Math.floor(jetzt / 1000) + 12 * 3600, sub: kontakt })}`;
  const sig = crypto.sign('sha256', Buffer.from(text), { key: privatSchluessel(k), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${text}.${b64(sig)}, k=${k.oeffentlich}`;
}

const hkdf = (salz: Buffer, ikm: Buffer, info: Buffer, laenge: number): Buffer => Buffer.from(crypto.hkdfSync('sha256', ikm, salz, info, laenge));
const INFO_SCHLUESSEL = Buffer.from('Content-Encoding: aes128gcm\0');
const INFO_NONCE = Buffer.from('Content-Encoding: nonce\0');

function ableiten(geheim: Buffer, auth: Buffer, geraet: Buffer, absender: Buffer, salz: Buffer): { schluessel: Buffer; nonce: Buffer } {
  const ikm = hkdf(auth, geheim, Buffer.concat([Buffer.from('WebPush: info\0'), geraet, absender]), 32);
  return { schluessel: hkdf(salz, ikm, INFO_SCHLUESSEL, 16), nonce: hkdf(salz, ikm, INFO_NONCE, 12) };
}

/** Angaben des Geräts aus der Anmeldung im Browser */
export interface GeraeteSchluessel { p256dh: string; auth: string }

/**
 * Nachricht für ein Gerät verschlüsseln – Ergebnis ist der Rumpf der Anfrage an den Push-Dienst
 * (Content-Encoding: aes128gcm). `fest` nur für Tests mit den Werten aus RFC 8291.
 */
export function verschluesseln(text: string | Buffer, g: GeraeteSchluessel, fest?: { salz: Buffer; privat: Buffer }): Buffer {
  const geraet = roh(g.p256dh), auth = roh(g.auth);
  if (geraet.length !== 65 || geraet[0] !== 4 || auth.length !== 16) throw new Error('Geräteschlüssel ungültig');
  const ecdh = crypto.createECDH('prime256v1');
  if (fest) ecdh.setPrivateKey(fest.privat); else ecdh.generateKeys();
  const absender = ecdh.getPublicKey();
  const salz = fest?.salz ?? crypto.randomBytes(16);
  const { schluessel, nonce } = ableiten(ecdh.computeSecret(geraet), auth, geraet, absender, salz);
  const c = crypto.createCipheriv('aes-128-gcm', schluessel, nonce);
  // 0x02 schließt den letzten (hier einzigen) Satz ab
  const daten = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const kopf = Buffer.alloc(21);
  salz.copy(kopf, 0); kopf.writeUInt32BE(4096, 16); kopf[20] = absender.length;
  return Buffer.concat([kopf, absender, daten]);
}

/** Gegenstück für Tests: so entschlüsselt das Gerät (privater Geräteschlüssel base64url) */
export function entschluesseln(rumpf: Buffer, g: GeraeteSchluessel & { privat: string }): Buffer {
  const salz = rumpf.subarray(0, 16), n = rumpf[20];
  const absender = rumpf.subarray(21, 21 + n), daten = rumpf.subarray(21 + n);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(roh(g.privat));
  const { schluessel, nonce } = ableiten(ecdh.computeSecret(absender), roh(g.auth), roh(g.p256dh), absender, salz);
  const d = crypto.createDecipheriv('aes-128-gcm', schluessel, nonce);
  d.setAuthTag(daten.subarray(daten.length - 16));
  const klar = Buffer.concat([d.update(daten.subarray(0, daten.length - 16)), d.final()]);
  return klar.subarray(0, klar.lastIndexOf(2));
}

/**
 * Push-Dienste, an die das Portal sendet. Die Adresse (endpoint) kommt vom Browser des Benutzers – ohne diese Liste
 * ließe sich der Server dazu bringen, beliebige Adressen im eigenen Netz aufzurufen.
 */
const DIENSTE = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export function pushDienstErlaubt(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && DIENSTE.some((d) => d.test(u.hostname));
  } catch { return false; }
}
