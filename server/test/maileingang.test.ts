/**
 * Rückmeldungen zu gesendeten E-Mails (E-Mail-Protokoll): Einordnen und Auswerten ohne Datenbank –
 * Unzustellbar-Meldung, Abwesenheitsnotiz, Antwort; fehlgeschlagene Adresse und Fehlerzeilen des Mailservers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adressenImText, betreffKern, einordnen, eingangZeit, messageIds, messageIdsImText, rueckGrund } from '../src/lib/maileingang.js';

const RUECK = `This message was created automatically by mail delivery software.

A message that you sent could not be delivered to one or more of its
recipients. This is a permanent error. The following address(es) failed:

  erika.muster@example.org
    host mx00.example.net [192.0.2.1]
    SMTP error from remote mail server after RCPT TO:<erika.muster@example.org>:
    550-Requested action not taken: mailbox unavailable
    550 For explanation visit https://postmaster.example.net/case?c=r1601`;

test('Einordnen: Rückläufer, Abwesenheit, Antwort', () => {
  assert.equal(einordnen({ von: 'Mail Delivery System <Mailer-Daemon@www1.example.net>', betreff: 'Mail delivery failed: returning message to sender' }), 'unzustellbar');
  assert.equal(einordnen({ von: 'a@b.de', betreff: 'Undelivered Mail Returned to Sender' }), 'unzustellbar');
  assert.equal(einordnen({ von: 'a@b.de', betreff: 'Automatische Antwort: Rechnung' }), 'abwesenheit');
  assert.equal(einordnen({ von: 'a@b.de', betreff: 'Re: Rechnung', auto: 'auto-replied' }), 'abwesenheit');
  assert.equal(einordnen({ von: 'a@b.de', betreff: 'AW: Rechnung' }), 'antwort');
});

test('Rückläufer: fehlgeschlagene Adresse (ohne eigene) und Fehlerzeilen des Mailservers', () => {
  assert.deepEqual(adressenImText(RUECK, ['Kasse <kasse@verein.example>']), ['erika.muster@example.org']);
  assert.deepEqual(adressenImText(`${RUECK}\nReturn-path: kasse@verein.example`, ['Kasse <kasse@verein.example>']), ['erika.muster@example.org']);
  assert.match(rueckGrund(RUECK), /^SMTP error from remote mail server .* 550-Requested action not taken: mailbox unavailable 550 For explanation/);
  assert.ok(!/192\.0\.2\.1/.test(rueckGrund(RUECK)), 'Zeile mit der Serveradresse gehört nicht zum Grund');
  assert.equal(rueckGrund('nichts Besonderes'), '');
});

test('Zuordnen: Betreff ohne Zusätze, Message-IDs, Datum', () => {
  assert.equal(betreffKern('AW: Re: WG:  Ihre Rechnung 2026_090'), 'ihre rechnung 2026_090');
  assert.deepEqual(messageIds('<A1@x.de> <b2@y.de>', 'a1@x.de', null), ['a1@x.de', 'b2@y.de']);
  assert.deepEqual(messageIdsImText('Message-ID: <abc@n8n.local>\nfoo'), ['abc@n8n.local']);
  const jetzt = new Date('2026-11-10T08:00:00Z');
  assert.equal(eingangZeit('2026-11-10T07:50:00+01:00', jetzt).toISOString(), '2026-11-10T06:50:00.000Z');
  assert.equal(eingangZeit('kaputt', jetzt), jetzt);
  assert.equal(eingangZeit('2030-01-01T00:00:00Z', jetzt), jetzt, 'Datum in der Zukunft zählt nicht');
});
