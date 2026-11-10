# Anleitungen für Anwender

| Anleitung | Markdown | PDF |
|---|---|---|
| Anmelden im Vereinsportal – für Mitglieder | [anmeldung-mitglieder.md](anmeldung-mitglieder.md) | [anmeldung-mitglieder.pdf](anmeldung-mitglieder.pdf) |
| Anmelden im Vereinsportal – für Hallenbucher | [anmeldung-hallenbucher.md](anmeldung-hallenbucher.md) | [anmeldung-hallenbucher.pdf](anmeldung-hallenbucher.pdf) |
| Halle buchen im Vereinsportal | [hallenbuchung.md](hallenbuchung.md) | [hallenbuchung.pdf](hallenbuchung.pdf) |

## Bilder

- **Bildschirmfotos** (alle Bilder außer den unten genannten): aufgenommen im Entwicklungsportal mit erfundenen Personen
  (Martina Muster, Hannes Beispiel). Die roten Zahlen wurden für die Aufnahme eingeblendet. Für Seiten, die sonst erst nach
  dem Absenden oder über einen Link aus einer E-Mail erscheinen, wurden die Antworten des Servers im Browser simuliert –
  dabei wurde nichts registriert, gespeichert oder versendet.
- **Hallenbuchung** (`hb-*.png`): aufgenommen im Entwicklungsportal mit einem Hallennutzer. Plätze, Zeiten, Belegung, Regeln und
  Preise sind die des Entwicklungsportals (November 2026); Name und Kontaktdaten sind durch „Hannes Beispiel“ ersetzt. Buchen,
  Ändern und Stornieren wurden im Browser simuliert – es wurde keine Buchung gespeichert. Beim Abo wurden Platz und Herkunft
  für das Bild auf „Halle“ bzw. Portal gesetzt.
- **Gezeichnete Bilder** (`m-wege.png` und alle `*-mail.png`, `m-c-5-freigabe.png`): erzeugt `scripts/anleitung.py`.
  Die E-Mail-Texte entsprechen denen des Portals.

## Neu erzeugen

Benötigt Python mit `playwright`, Google Chrome und `pandoc`:

```bash
python3 scripts/anleitung.py          # gezeichnete Bilder und PDFs
python3 scripts/anleitung.py --pdf    # nur PDFs, nach Änderungen am Text
```

Ändern sich die Anmeldeseiten, die betroffenen Bildschirmfotos neu aufnehmen (Breite etwa 512 Pixel).

**Vereinslayout der PDFs** (wie die PDFs des Portals, z. B. Einnahmen-Ausgaben-Rechnung, `modules/tco/server/pdf/layout.ts`):
Deckblatt mit orangefarbenem Kopfband, Titel und weißem Vereinslogo, darunter Einleitung und Inhalt; jedes Kapitel auf einer
neuen Seite mit Folgekopf (Titel links, Verein rechts, orangefarbene Linie); Zwischenüberschriften in Großbuchstaben;
Hinweise und Tabellen als Karten mit grauem Rand; Fußband mit orangefarbener Linie und Seitenzahl.

```bash
python3 scripts/anleitung.py --pdf hallenbuchung   # nur eine Anleitung neu erzeugen
```

**Anrede:** „Halle buchen“ duzt die Leser (persönliches Du). Die beiden Anmelde-Anleitungen verwenden noch „Sie“.
