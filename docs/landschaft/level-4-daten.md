<!-- Automatisch erzeugt von scripts/landschaft.mjs – nicht von Hand ändern. Quelle der Prozesse: docs/landschaft/prozesse.json -->
# Level 4 – Datenbankabhängigkeiten

Abgeleitet aus den Quelltexten hinter den Routen jedes Prozessschritts (Routendatei plus direkt importierte Dateien im selben Ordner). Das ist eine Näherung: eine Tabelle steht hier, wenn der Code sie in diesen Dateien nennt.

| Tabelle | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | D1 | D2 | D3 | D4 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `core.backup_export` |  |  |  |  |  |  |  | ● |  |  |  |  |
| `core.number_ranges` |  |  | ● |  |  |  |  |  |  |  |  | ● |
| `core.nutzung` |  |  |  |  |  |  |  |  | ● | ● |  |  |
| `core.password_tokens` |  |  |  |  |  |  |  |  | ● | ● |  |  |
| `core.role_permissions` |  |  | ● |  |  |  |  |  | ● |  |  | ● |
| `core.roles` |  |  | ● |  |  |  |  |  | ● |  |  | ● |
| `core.sessions` | ● |  |  |  |  |  |  |  | ● | ● | ● |  |
| `core.settings` |  |  |  |  |  |  |  |  | ● | ● |  |  |
| `core.sperren` |  |  | ● |  |  |  |  |  | ● |  |  | ● |
| `core.user_roles` | ● |  | ● |  |  |  |  |  | ● | ● | ● | ● |
| `core.users` | ● |  | ● | ● |  |  |  |  | ● | ● | ● | ● |
| `tco.anlagen` |  |  |  |  |  |  |  | ● |  |  |  |  |
| `tco.antrag_map` | ● |  |  |  |  |  |  |  |  |  | ● |  |
| `tco.beitrag` | ● | ● |  |  |  |  |  |  |  |  | ● |  |
| `tco.beitrag_pr` | ● | ● |  |  |  |  |  |  |  |  | ● |  |
| `tco.bookings` |  |  | ● |  |  |  |  | ● | ● |  |  | ● |
| `tco.bookings_ch` |  |  | ● |  |  |  |  | ● |  |  |  | ● |
| `tco.bookingstxt` |  |  | ● |  |  |  |  |  | ● |  |  | ● |
| `tco.eing_dokumente` |  |  |  |  |  | ● |  |  |  |  |  |  |
| `tco.eing_korrespondenten` |  |  |  |  |  | ● |  |  |  |  |  |  |
| `tco.eing_regeln` |  |  |  |  |  | ● |  |  |  |  |  |  |
| `tco.eing_vorgaenge` |  |  |  |  |  | ● |  |  |  |  |  |  |
| `tco.einladungen` | ● |  |  |  |  |  |  |  |  |  | ● |  |
| `tco.ferien` |  |  |  | ● |  |  |  |  |  |  |  |  |
| `tco.fibankab` |  | ● | ● |  |  | ● |  | ● |  |  |  |  |
| `tco.fibankiban` |  | ● | ● |  |  | ● |  | ● |  |  |  |  |
| `tco.fibuchungen` |  | ● | ● |  | ● | ● |  | ● |  |  |  | ● |
| `tco.fikonten` |  | ● | ● |  |  | ● |  | ● |  |  |  | ● |
| `tco.fikontojahr` |  | ● | ● |  |  | ● |  | ● |  |  |  |  |
| `tco.finotiz` |  | ● | ● |  |  | ● |  | ● |  |  |  |  |
| `tco.fipapermap` |  | ● | ● |  | ● | ● |  | ● |  |  |  |  |
| `tco.forderungen` |  |  |  |  | ● |  |  | ● |  |  |  |  |
| `tco.jrueckm` |  |  |  | ● |  |  |  | ● |  |  |  |  |
| `tco.jt_doku` |  |  |  | ● |  |  |  | ● |  |  |  |  |
| `tco.kal_anmeldungen` |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.kal_event_regeln` |  |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.kal_events` | ● |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.kal_gruppe_mitglieder` | ● |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.kal_gruppen` | ● |  |  |  |  |  | ● |  |  |  |  |  |
| `tco.kal_gruppen_regeln` | ● |  |  |  |  |  |  |  |  |  |  |  |
| `tco.kommpref` | ● |  | ● |  |  |  |  |  |  |  | ● | ● |
| `tco.kunden` | ● |  | ● |  |  |  |  |  | ● |  | ● | ● |
| `tco.mgnotiz` | ● |  |  |  |  |  |  |  |  |  | ● |  |
| `tco.mitglieder` | ● | ● | ● | ● | ● | ● | ● | ● | ● |  | ● | ● |
| `tco.mitgliedera` | ● |  | ● | ● |  |  | ● |  | ● |  | ● | ● |
| `tco.mitgliedsantraege` | ● |  |  |  |  |  |  | ● |  |  | ● |  |
| `tco.plaetze` |  |  | ● |  |  |  |  | ● | ● |  |  | ● |
| `tco.platzbelegungen` |  |  | ● |  |  |  |  | ● | ● |  |  | ● |
| `tco.prmatrix` |  |  | ● |  |  |  |  |  |  |  |  | ● |
| `tco.produkte` |  |  | ● |  | ● |  |  |  |  |  |  | ● |
| `tco.registrierungen` |  |  | ● |  |  |  |  | ● | ● |  |  | ● |
| `tco.rgkopf` |  | ● | ● |  |  | ● |  | ● |  |  |  | ● |
| `tco.rgpos` |  |  | ● |  |  |  |  | ● |  |  |  | ● |
| `tco.rgtz` |  | ● | ● |  |  | ● |  | ● |  |  |  | ● |
| `tco.schluessel` | ● |  | ● |  |  |  |  |  |  |  | ● | ● |
| `tco.schnupper` | ● |  |  | ● |  |  |  | ● |  |  | ● |  |
| `tco.schnupper_einheiten` | ● |  |  |  |  |  |  |  |  |  |  |  |
| `tco.sepa` | ● | ● |  |  |  |  |  |  |  |  | ● |  |
| `tco.soll_cfg` | ● | ● |  |  |  |  |  |  |  |  | ● |  |
| `tco.soll_kopf` |  | ● |  |  |  |  |  |  |  |  |  |  |
| `tco.soll_pos` |  | ● |  |  |  |  |  |  |  |  |  |  |
| `tco.trentgelt` |  |  |  | ● |  |  |  |  |  |  |  |  |
| `tco.verein` |  |  |  |  | ● |  |  |  |  |  |  |  |
| `tco.vertraege` | ● | ● |  |  |  |  |  | ● |  |  | ● |  |
| `tco.vertragsangebote` | ● |  |  |  |  |  |  |  |  |  | ● |  |
| `tco.vz_belege` |  | ● |  |  | ● |  |  | ● |  |  |  |  |
| `tco.vz_cfg` |  | ● |  |  | ● |  |  |  |  |  |  |  |
| `tco.vz_posten` |  |  |  |  | ● |  |  | ● |  |  |  |  |
| `tco.werg` |  |  |  |  | ● |  |  |  |  |  |  |  |
| `tco.werg_beleg` |  |  |  |  | ● |  |  |  |  |  |  |  |

**P1** Mitglied werden · **P2** Beiträge einziehen · **P3** Halle buchen und abrechnen · **P4** Jugendtraining abrechnen · **P5** Clubhaus und Verzehr · **P6** Dokumenteneingang · **P7** Vereinsleben (Kalender) · **P8** Abschluss und Steuerung · **D1** Registrierung · **D2** Passwort vergessen · **D3** Mitgliederanlage · **D4** Hallenbuchung

## Weitere Tabellen (16, von keinem beschriebenen Prozess berührt)

`core.api_keys`, `core.change_header`, `core.change_item`, `core.mail_antworten`, `core.mail_protokoll`, `core.paperless_mapping`, `core.tabellen_papierkorb`, `core.verbindungen`, `tco.ford`, `tco.mail_protokoll`, `tco.paperless`, `tco.projekte`, `tco.rpt_variant`, `tco.tfrei`, `tco.tplan`, `tco.werg_pl`
