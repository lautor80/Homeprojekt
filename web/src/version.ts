/**
 * Aktive Version des Portals in der Kopfzeile neben dem Logo: Uhrzeit des Codes (Commit), aus dem das laufende Image
 * gebaut wurde – setzt die CI (Dockerfile: BUILD_ZEIT, BUILD_SHA), geliefert in /api/auth/me.
 */
/** „Stand 14.11. 20:03“ aus der Uhrzeit des Commits (Ortszeit), Titel mit Datum, Jahr und Kennung; null ohne Angabe */
export function versionText(v?: { zeit: string | null; sha: string | null }, zone = 'Europe/Berlin'): { text: string; titel: string } | null {
  if (!v?.zeit) return null;
  const d = new Date(v.zeit);
  if (Number.isNaN(d.getTime())) return null;
  const tag = d.toLocaleDateString('de-DE', { timeZone: zone, day: '2-digit', month: '2-digit' });
  const uhr = d.toLocaleTimeString('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  return { text: `Stand ${tag} ${uhr}`, titel: `Aktive Version: Code vom ${d.toLocaleString('de-DE', { timeZone: zone })}${v.sha ? ` (${v.sha})` : ''}` };
}
