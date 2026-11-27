/**
 * Schnuppertraining – durchgängiger Prozess je Schnupperer: Anfrage → Schnuppern → Vertragsangebot → Mitgliedsantrag → Mitglied.
 * Reine Funktion ohne Datenbank und ohne Paketimporte (Test: server/test/tco_schnupper_prozess.test.ts); die Angaben liest
 * schnupperLesen (schnupper/logik.ts).
 */
export interface ProzessSchritt {
  schritt: 'ANFRAGE' | 'SCHNUPPERN' | 'ANGEBOT' | 'ANTRAG' | 'MITGLIED';
  titel: string;
  zustand: 'erledigt' | 'aktiv' | 'offen' | 'abgebrochen';
  info: string | null;
}

/** Vertragsangebot am Schnupperer (jüngstes mit schnupper_adrnr); abgelaufen = noch offen, aber Gültigkeit vorbei */
export interface ProzessAngebot {
  id: number; nummer: string; status: 'OFFEN' | 'ANGENOMMEN' | 'ZURUECKGEZOGEN'; gueltig_bis: string; abgelaufen: boolean; antrag: string | null;
}

/** Die für den Prozess nötigen Angaben – strukturell ein Ausschnitt von SchnupperZeile */
export interface ProzessEingabe {
  status: 'NEU' | 'KONTAKTIERT' | 'TERMIN' | 'ABSOLVIERT' | 'MITGLIED' | 'ABGESAGT';
  /** Eingang der Anmeldung (Zeitpunkt, ISO-Text oder Date) */
  eingang: string | Date;
  einheit1: string | null; einheit2: string | null;
  /** Tage mit Schnuppertraining laut „Meine Trainingszeiten“ */
  einheiten: number;
  mitglnrn: string;
  angebot: ProzessAngebot | null;
  antrag_nr: string | null;
  antrag_status: 'EINGANG' | 'UEBERNOMMEN' | 'ABGELEHNT' | null;
}

export const PROZESS_TITEL: Record<ProzessSchritt['schritt'], string> = {
  ANFRAGE: 'Anfrage', SCHNUPPERN: 'Schnuppern', ANGEBOT: 'Vertragsangebot', ANTRAG: 'Mitgliedsantrag', MITGLIED: 'Mitglied',
};

/** JJJJ-MM-TT → TT.MM.JJJJ */
const tag = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Zeitpunkt → TT.MM.JJJJ in Berliner Zeit; reines Datum (JJJJ-MM-TT) unverändert als Tag */
function eingangText(z: string | Date): string | null {
  if (typeof z === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(z)) return tag(z);
  const d = new Date(z);
  if (Number.isNaN(d.getTime())) return null;
  return tag(d.toLocaleString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 10));
}

/** Immer genau fünf Schritte in fester Reihenfolge; bei „Abgesagt“ sind alle noch nicht erledigten abgebrochen */
export function prozessSchritte(z: ProzessEingabe, einheitenKostenlos = 2): ProzessSchritt[] {
  const mitglied = z.status === 'MITGLIED';
  const a = z.angebot;
  const s = (schritt: ProzessSchritt['schritt'], zustand: ProzessSchritt['zustand'], info: string | null = null): ProzessSchritt =>
    ({ schritt, titel: PROZESS_TITEL[schritt], zustand, info });

  // Schnuppern: Einheiten laut Trainingszeiten bzw. von Hand eingetragene Termine
  const n = Math.max(z.einheiten, (z.einheit1 ? 1 : 0) + (z.einheit2 ? 1 : 0));
  const geschnuppert = z.status === 'ABSOLVIERT' || mitglied || z.einheiten >= einheitenKostenlos || !!z.einheit2;
  const einheitenInfo = n > einheitenKostenlos ? `${n} Einheiten` : `${n} von ${einheitenKostenlos} Einheiten`;
  const schnuppern = s('SCHNUPPERN', geschnuppert ? 'erledigt' : z.status === 'ABGESAGT' ? 'abgebrochen' : 'aktiv', einheitenInfo);

  // Vertragsangebot: angenommen bzw. durch einen Antrag überholt (Beitrittslink ohne Angebot)
  let angebot: ProzessSchritt;
  if (a?.status === 'ANGENOMMEN') angebot = s('ANGEBOT', 'erledigt', `${a.nummer} angenommen`);
  else if (z.antrag_nr || mitglied) angebot = s('ANGEBOT', 'erledigt', a ? a.nummer : 'ohne Angebot (Beitrittslink)');
  else if (a?.status === 'ZURUECKGEZOGEN') angebot = s('ANGEBOT', 'abgebrochen', `${a.nummer} zurückgezogen`);
  else if (a && a.abgelaufen) angebot = s('ANGEBOT', 'abgebrochen', `${a.nummer} abgelaufen am ${tag(a.gueltig_bis)}`);
  else if (a) angebot = s('ANGEBOT', 'aktiv', `${a.nummer} offen bis ${tag(a.gueltig_bis)}`);
  else angebot = s('ANGEBOT', 'offen');

  // Mitgliedsantrag
  let antrag: ProzessSchritt;
  if (z.antrag_status === 'UEBERNOMMEN' || mitglied) antrag = s('ANTRAG', 'erledigt', z.antrag_nr ? `${z.antrag_nr} übernommen` : null);
  else if (z.antrag_status === 'EINGANG') antrag = s('ANTRAG', 'aktiv', `${z.antrag_nr ?? 'Antrag'} in Prüfung`);
  else if (z.antrag_status === 'ABGELEHNT') antrag = s('ANTRAG', 'abgebrochen', `${z.antrag_nr ?? 'Antrag'} abgelehnt`);
  else antrag = s('ANTRAG', 'offen');

  const schritte = [
    s('ANFRAGE', 'erledigt', eingangText(z.eingang)),
    schnuppern, angebot, antrag,
    s('MITGLIED', mitglied ? 'erledigt' : 'offen', mitglied && z.mitglnrn.trim() ? `Nr. ${z.mitglnrn.trim()}` : null),
  ];
  return z.status === 'ABGESAGT' ? schritte.map((x) => (x.zustand === 'erledigt' ? x : { ...x, zustand: 'abgebrochen' as const })) : schritte;
}
