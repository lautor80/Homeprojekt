# Imagevideo zum Vereinsportal (#153)

Kurzes Imagevideo für Mitglieder und Hallenbucher: **[TCO_Vereinsportal_Imagevideo.mp4](TCO_Vereinsportal_Imagevideo.mp4)**
(62,5 Sekunden, 1920 × 1080, 30 Bilder/s, H.264 mit AAC-Ton, rund 8 MB – geeignet für Website, WhatsApp und Beamer).

| Zeit | Szene | Gezeigt wird | Botschaften |
|---|---|---|---|
| 0:00 | Auftakt | Vereinslogo, „Das neue Vereinsportal“ | Für Mitglieder und Hallenbucher, rund um die Uhr |
| 0:05 | 1 Hallenbuchung | Tageskalender, freie Zeit antippen, „Platz buchen“ mit Preis, Buchung im Kalender | Freie Zeiten auf einen Blick · Preis sofort sichtbar · selbst ändern und stornieren |
| 0:15 | 2 Meine Mitgliedschaft | Kontaktdaten ändern (neue Anschrift), Bankverbindung, Verträge | Anschrift, Telefon, E-Mail selbst ändern · Bankverbindung online · Verträge der Familie im Blick |
| 0:25 | 3 Vereinskalender | Terminliste, Begleitung angeben, „Dabei“ / „Nicht dabei“ | Alle Termine an einem Ort · Begleitung mit anmelden · mit einem Tipp zu- oder absagen |
| 0:35 | 4 Verträge und Familie | Vertragsangebot prüfen und bestätigen: zweites Jugendtraining, weiteres Kind im Familienbeitrag | Zweites Jugendtraining · Familie in den Familienbeitrag · online bestätigen ohne Papier |
| 0:45 | 5 Schnuppertraining | Öffentliche Anmeldung ausfüllen und absenden | Ohne Benutzerkonto · Wunschtermine angeben · der Trainer meldet sich |
| 0:55 | Schluss | Vorteile für Mitglieder und für Hallenbucher, Logo, „Jetzt anmelden und loslegen“ | – |

Die Oberflächen im Video sind dem Portal **nachgebaut** (Aufbau und Texte wie in den Apps „Platz buchen“, „Meine Mitgliedschaft“,
„Vereinskalender“, Mitgliedsantrag/Vertragsangebot und „Schnuppertraining“), damit sie im Video groß, ruhig und animiert gezeigt
werden können. Alle Personen und Daten sind erfunden (Martina Muster, Hannes Beispiel …). Farben, Logo und Schrift folgen dem
Vereinsauftritt (Orange `E2701F`, Inter).

## Dateien

| Datei | Zweck |
|---|---|
| `film.html` | Alle Szenen als eine Seite. Jede Bewegung hängt nur von der Zeit ab: `window.seek(szene, sekunden)` stellt ein Bild exakt ein. Vorschau im Browser: `film.html?s=2&t=5.5` |
| `dreh.py` | Filmt die Seite Bild für Bild mit Google Chrome (Playwright), kodiert jede Szene einzeln und fügt sie ohne Neukodierung zusammen |
| `musik.py` | Errechnet die Musik (96 Schläge/Minute, je Szene vier Takte) – keine fremden Aufnahmen, daher frei verwendbar |

## Neu erzeugen

Benötigt Python mit `playwright`, `numpy` und `scipy`, Google Chrome, `ffmpeg` sowie die Schriften Inter und Inter Display.

```bash
python3 docs/imagevideo/dreh.py bild 1:5.5 4:3.2   # Standbilder zur Kontrolle (Szene:Sekunde) nach /tmp/imagevideo
python3 docs/imagevideo/dreh.py szene 3            # nach einer Änderung nur diese Szene neu filmen
python3 docs/imagevideo/dreh.py film               # fehlende Szenen filmen, zusammenfügen, Musik unterlegen
```

Ändern:

- **Texte und Abläufe** stehen in `film.html` je Szene (`<section class="scene" id="s1" data-dauer="10">`). Zeitpunkte sind
  Sekunden ab Szenenbeginn: `--t` (Erscheinen), `--t2` (Verschwinden), `data-tipp` (Text wird getippt), `data-folge`
  (Text wechselt), `data-ab` (Klasse ab Zeitpunkt, z. B. Knopf wird grün), `data-auf`/`data-t` (Antippen), `data-weg` (Mauszeiger).
- **Szenendauern** sollten Vielfache von 2,5 s bleiben, damit die Musik mit den Szenen wechselt.
- **Andere Musik:** eigene Datei statt `musik.py` unterlegen, ohne das Bild neu zu kodieren:
  `ffmpeg -i TCO_Vereinsportal_Imagevideo.mp4 -i musik.mp3 -map 0:v -map 1:a -c:v copy -shortest neu.mp4`.
  Ohne Ton: `ffmpeg -i TCO_Vereinsportal_Imagevideo.mp4 -an -c:v copy stumm.mp4`.
