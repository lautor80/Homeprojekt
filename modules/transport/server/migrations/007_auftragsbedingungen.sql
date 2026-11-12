-- #170: Auftragsbedingungen (AGB) für den Transportauftrag an den Unternehmer – in den Stammdaten (Firma) pflegbar.
alter table transport.firma add column if not exists auftragsbedingungen text not null default '';
update transport.firma set auftragsbedingungen = $agb$Der Fahrer ist anzuweisen, die Ladung ordnungsgemäß zu sichern (mindestens 18 geeignete Gurte)!

Sie wurden von uns auf Lade- und Entladetermine hingewiesen und haben sich zur Einhaltung dieser verpflichtet. Bei Nichteinhaltung werden Sie von uns voll haftbar gehalten, und wir behalten uns vor, die Fracht um 30 % zu kürzen. Bei etwaigen Verspätungen/Schwierigkeiten müssen wir sofort informiert werden. Fixtermine sind bindend – d. h. bei Nichteinhaltung behalten wir uns das Recht vor, die Fracht je nach Fall um bis zu 50 % zu kürzen!

Be- und Entladung 3 Stunden standgeldfrei!

KUNDENSCHUTZ GILT ALS VEREINBART! BEI NICHTEINHALTUNG ERHEBEN WIR SCHADENERSATZ VON 10.000 EURO!

Zahlungsziel: 30 Tage oder 7 Tage mit 1 % oder 24 Stunden mit 2 % Skonto. Als Abliefernachweis werden sowohl CMR als AUCH die Lieferscheine benötigt!!!

Wir arbeiten ausschließlich aufgrund der ADSp, jeweils neueste Fassung. CMR-Versicherung Ihrerseits gilt als vereinbart.

ZUSATZ: Mit Erhalt unseres Transportauftrages bestätigt der Auftragnehmer die Einhaltung des Mindestlohngesetzes (MiLoG). Der Auftragnehmer befreit den Auftraggeber von allen Ersatzansprüchen im Falle eines Verstoßes gegen das MiLoG. Dies gilt auch für Ansprüche Dritter.$agb$
 where id = 1 and auftragsbedingungen = '';
