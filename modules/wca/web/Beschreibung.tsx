import { Section } from '@core/components/Section';
import type { RegelInfo } from '../server/typen';
import { ARTEN, KATEGORIEN, type Spalte, Tabelle } from './util';

/** Reiter „Beschreibung“: Hilfeseite zur Methodik der Zeitenkontrolle */
export function Beschreibung({ regeln }: { regeln: RegelInfo[] }) {
  const spalten: Spalte<RegelInfo>[] = [
    { titel: 'Regel', fest: true, wert: (r) => <b>{r.id}</b> },
    { titel: 'Name', wert: (r) => r.name },
    { titel: 'Rubrik', wert: (r) => ARTEN[r.art] ?? r.art },
    { titel: 'Erkennung', breit: true, wert: (r) => r.erkennung },
    { titel: 'Empfehlung', breit: true, wert: (r) => r.tipp },
  ];
  const kats = ['K', 'P', 'T', 'R'] as const;
  return (
    <div className="portal-wca-hilfe">
      <Section title="Worum es geht">
        <p>
          Die Zeitenkontrolle liest die Teamreports aus Tempo (CSV-Export „Teamreport“ mit Tagesspalten) und prüft die Zeitbuchungen eines Teams:
          ob jeder Arbeitstag vollständig gebucht ist, wie sich die Stunden auf Billable, PreSales, Intern und Abwesenheit verteilen,
          ob die Kontierung plausibel ist und ob die Rückmeldetexte die Tätigkeit verständlich beschreiben.
        </p>
        <p>
          Importiert werden beliebig viele Exporte; überschneiden sich zwei Dateien, gilt je Person und Tag die zuletzt importierte Datei.
          Ausgewertet wird immer ein <b>Zeitraum</b> (Monat, Kalenderwoche oder alles – auch mehrere zusammen; Tage zwischen den gewählten Zeiträumen zählen nicht) bis zum <b>Stichtag</b> – dem letzten bewerteten Tag.
          Vorschlag für den Stichtag ist der letzte Arbeitstag vor heute, begrenzt auf die vorhandenen Daten.
        </p>
      </Section>

      <Section title="Typ einer Buchung">
        <ul>
          <li><b>Abwesenheit (A)</b>: Account „ATG Absence …“, Jira-Projekt ATGABS oder Text beginnt mit „Absence:“.</li>
          <li><b>Billable (B)</b>: Kategorietyp beginnt mit „Abrechenbar“ bzw. „Billable“.</li>
          <li><b>PreSales (P)</b>: Jira-Projektschlüssel enthält „PRESAL“ oder Account enthält „PreSales“.</li>
          <li><b>Intern (I)</b>: alles Übrige.</li>
        </ul>
        <p>
          Die Reihenfolge entscheidet: Eine Abwesenheit unter dem Kategorietyp „Intern“ ist Abwesenheit, ein PreSales-Ticket unter „Intern“ ist PreSales.
          Die <b>Billable-Quote</b> ist Billable / (Billable + PreSales + Intern) – Abwesenheit zählt nicht mit.
        </p>
      </Section>

      <Section title="Soll und Ist">
        <ul>
          <li><b>Standort</b> ergibt sich aus den internen Projekten (WDE… → DE, WAT… → AT …) und bestimmt die Feiertage; in Deutschland gilt das eingestellte Bundesland.</li>
          <li><b>Arbeitstage</b>: aus den letzten bis zu zehn Wochen mit Buchungen abgeleitet (ein Wochentag zählt, wenn in mindestens 45 % der Wochen gebucht wurde, Wochenende 60 %); sonst Mo–Fr.</li>
          <li><b>Soll je Tag</b>: Median der Tagessummen an normalen Arbeitstagen, auf halbe Stunden gerundet, zwischen 2 und 8 h; bei zu wenigen Tagen 8 h.</li>
          <li><b>Im Team von–bis</b>: erste Buchung bis letzte Buchung, wenn danach mehr als 15 Arbeitstage nichts mehr kam; sonst offen.</li>
          <li>Feiertage werden berechnet, manuell ergänzt oder erkannt (an einem Werktag hat kaum jemand am Standort gebucht).</li>
        </ul>
        <p>
          Je Arbeitstag bis zum Stichtag wird das Soll mit den gebuchten Stunden verglichen. Liegt die Differenz über der Toleranz, ist der Tag <b>teilweise</b>{' '}
          gebucht bzw. <b>fehlt</b>; Abwesenheit zählt als gebucht. Mehrstunden an einem Tag gleichen fehlende Stunden an einem anderen Tag <b>nicht</b> aus.
          Eine Person ist <b>vollständig</b>, wenn die offenen Stunden im Zeitraum innerhalb der Toleranz liegen. Alle abgeleiteten Werte lassen sich je Person
          in der App „Prüfregeln“ überschreiben; dort lassen sich Personen auch ausblenden.
        </p>
      </Section>

      <Section title="Stufen und Zählweise">
        <ul>
          <li>Jeder Fund hat eine Stufe: <b>Niedrig</b> (Hinweis), <b>Mittel</b> (bitte prüfen), <b>Hoch</b> (bitte korrigieren). Bei abrechenbaren Buchungen sind Textmängel meist eine Stufe höher.</li>
          <li>Eine Rückmeldung (bzw. ein Personentag bei Tagesprüfungen) ist eine Zeile mit allen ihren Fehlern; ihre Stufe ist die höchste.</li>
          <li>Der Filter <b>Stufe ab</b> (Standard Mittel) blendet Zeilen aus, die nur Fehler unterhalb der Stufe haben.</li>
          <li><b>Texte unauffällig</b> ist der Anteil der Einträge (ohne Abwesenheit) ohne Textfund – das Regelwerk zählt dabei nicht mit.</li>
          <li>Der <b>Rückfrage-Text</b> je Person fasst offene Tage und Funde ab Stufe Mittel zusammen und lässt sich kopieren.</li>
        </ul>
      </Section>

      {kats.map((k) => {
        const rs = regeln.filter((r) => r.kategorie === k);
        if (!rs.length) return null;
        return (
          <Section key={k} title={`Regeln: ${KATEGORIEN[k]}`} count={rs.length} flush>
            <Tabelle<RegelInfo> spalten={spalten} zeilen={rs} schluessel={(r) => r.id} />
          </Section>
        );
      })}
    </div>
  );
}
