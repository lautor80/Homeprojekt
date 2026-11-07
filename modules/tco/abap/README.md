# SAP-Datenübernahme TCO

1. `ZTCO_PORTAL_EXPORT` per abapGit (Ordner `src/utilities`) oder SE38 (Copy & Paste) anlegen und aktivieren.
2. Report ausführen → speichert `TCO_PORTAL_EXPORT_<Datum>.zip` mit allen ZTCO-Tabellen als CSV (UTF-8, `;`).
   Der Report liest nur, er ändert in SAP nichts.
3. Portal → TC Oberthal → Stammdaten → SAP-Import: ZIP wählen, **Prüfen**, dann **Übernehmen**
   (Modus „Nur neue Sätze“ für die Erstübernahme, „Aktualisieren“ für einen erneuten Abgleich).
