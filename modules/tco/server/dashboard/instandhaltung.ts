/**
 * Vereinsübersicht, Bereich „Instandhaltung“ (#205): offene Schäden, davon Sicherheitsrisiken und gesperrte Plätze,
 * im laufenden Jahr erledigte Schäden mit Kosten.
 */
import type { Db } from '../verein.js';
import { kennzahlen } from '../instandhaltung/logik.js';
import type { Kpi } from './kpi.js';

const basis = { subtitle: '', unit: '', trend: 'None', state: 'None', details: '', icon: '', hasDetail: false, todo: false } as const;

export async function collectInstandhaltung(db: Db): Promise<Kpi[]> {
  const k = await kennzahlen(db);
  const jahr = new Date().getFullYear();
  return [
    {
      ...basis, key: 'IH_OFFEN', title: 'Offene Schäden', subtitle: k.neu ? `davon ${k.neu} neu` : 'gemeldet, noch nicht erledigt',
      value: String(k.offen), unit: 'Meldungen', icon: 'technical-object',
      state: k.sicher ? 'Negative' : k.offen ? 'Critical' : 'Positive',
      details: k.offen ? `${k.sicher} Sicherheitsrisiko · ${k.ueberfaellig} überfällig · ${k.gesperrt} Platz/Plätze gesperrt${k.aeltester ? ` · älteste vom ${k.aeltester}` : ''}` : 'Alles in Ordnung',
    },
    {
      ...basis, key: 'IH_SICHER', title: 'Sicherheitsrisiken', subtitle: 'offen', value: String(k.sicher), unit: 'Meldungen', icon: 'alert',
      state: k.sicher ? 'Negative' : 'Positive', details: k.sicher ? 'Bitte umgehend prüfen bzw. absperren' : 'Keine offenen Sicherheitsrisiken',
    },
    {
      ...basis, key: 'IH_GESPERRT', title: 'Gesperrte Plätze', subtitle: 'wegen Schäden', value: String(k.gesperrt), unit: 'Plätze', icon: 'locked',
      state: k.gesperrt ? 'Critical' : 'None', details: 'Sperrzeit in der Platzbuchung aus der Instandhaltung',
    },
    {
      ...basis, key: 'IH_ERLEDIGT', title: 'Erledigte Schäden', subtitle: `Jahr ${jahr}`, value: String(k.erledigtJahr), unit: 'Meldungen', icon: 'accept',
      state: 'Positive', display: 'CARD',
      details: `Kosten ${k.kostenJahr.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`,
    },
  ];
}
