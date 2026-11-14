<!-- Automatisch erzeugt von scripts/landschaft.mjs – nicht von Hand ändern. Quelle der Prozesse: docs/landschaft/prozesse.json -->
# System- und Prozesslandschaft TC Oberthal

Mehrstufige Landschaft zu Issue #118. Die Seiten werden aus dem Code erzeugt; nur `prozesse.json` wird von Hand gepflegt.

| Ebene | Inhalt | Seite |
|---|---|---|
| 1 | Systeme, Apps (38), Schnittstellen (5 n8n-Workflows, 9 Anbindungen), Container (10) | [level-1-systeme.md](level-1-systeme.md) |
| 2 | Kernprozesse (10) mit Schritten, Akteuren, Routen, Rechten | [level-2-prozesse.md](level-2-prozesse.md) |
| 3 | Detailprozesse (4) | [level-3-details.md](level-3-details.md) |
| 4 | Datenbankabhängigkeiten (111 Tabellen) | [level-4-daten.md](level-4-daten.md) |

## Aktualisieren

```bash
npm run doku:landschaft   # neu erzeugen
npm run doku:pruefen      # nur prüfen (CI)
```

Der Workflow `.github/workflows/landschaft.yml` prüft jeden Pull Request (kaputte Verweise in `prozesse.json` lassen ihn fehlschlagen) und erzeugt die Seiten nach jedem Push auf `main` neu.

**Neuen Prozess aufnehmen:** Eintrag in `prozesse.json` (ebene 2 oder 3) mit Schritten; je Schritt `akteur`, `system` und – soweit vorhanden – `route` (z. B. `POST /antrag`), `recht`, `app`, `workflow`. Danach `npm run doku:landschaft`.

**Farben** wie im Board: blau = Portal, grün = n8n, petrol = externes System, grau gestrichelt = manuell.
