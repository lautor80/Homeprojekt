const pptxgen = require('pptxgenjs');
const { applyTheme } = require(process.env.APPLY_THEME || './apply_theme.js');
const fs = require('fs');

// TCO-Branding wie in den PDF-Belegen (modules/tco/server/pdf/layout.ts)
const THEME = {
  name: 'TC Oberthal', headFontFace: 'Arial', bodyFontFace: 'Arial',
  colors: { dk1: '1F1F1F', lt1: 'FFFFFF', dk2: '3A3A3A', lt2: 'F6F4F2', accent1: 'E2701F', accent2: 'B9561A', accent3: '6B6B6B',
    accent4: 'F2A66B', accent5: '2E7D32', accent6: 'C62828', hlink: 'B9561A', folHlink: '6B6B6B' },
};
const img = (f) => 'image/png;base64,' + fs.readFileSync(f).toString('base64');
const path = require('path');
const ASSETS = process.env.ASSETS || path.join(__dirname, '..', '..', 'modules', 'tco', 'server', 'assets');
const ZIEL = process.argv[2] || 'praesentation_beispiel.pptx';
const LOGO_W = img(path.join(ASSETS, 'logo_weiss.png')), LOGO_O = img(path.join(ASSETS, 'logo_orange.png'));
const LR = 487 / 800; // Seitenverhältnis Logo

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = 'TC Oberthal – Beispielvorlage';
pres.author = 'TC Oberthal';
pres.company = 'TC Oberthal';
const C = pres.SchemeColor;
const fuss = (dunkel) => [
  { image: { x: 12.15, y: 6.85, w: 0.75, h: 0.75 * LR, data: dunkel ? LOGO_W : LOGO_O } },
  { text: { text: '{{verein.name}} · {{praesentation.titel}} · Stand {{stand.datum}}', options: { x: 0.6, y: 6.9, w: 9, h: 0.35, fontSize: 10, color: dunkel ? C.background1 : C.accent3, margin: 0 } } },
];
pres.defineSlideMaster({
  title: 'TCO Titel', background: { color: THEME.colors.accent1 },
  objects: [
    { image: { x: 0.6, y: 0.6, w: 2.2, h: 2.2 * LR, data: LOGO_W } },
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 2.6, w: 11, h: 1.6, fontSize: 44, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: 'Titel der Präsentation' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.6, y: 4.35, w: 11, h: 1.2, fontSize: 20, color: C.background1, valign: 'top', margin: 0 }, text: 'Untertitel' } },
  ],
});
pres.defineSlideMaster({
  title: 'TCO Kapitel', background: { color: THEME.colors.dk1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 2.5, w: 10, h: 1.4, fontSize: 40, bold: true, color: C.background1, align: 'left', margin: 0 }, text: 'Kapitel' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 0.6, y: 3.95, w: 10, h: 1, fontSize: 18, color: C.accent4, margin: 0 }, text: 'Worum es geht' } },
    ...fuss(true),
  ],
  slideNumber: { x: 11.4, y: 6.92, w: 0.6, h: 0.3, fontSize: 10, color: THEME.colors.lt1 },
});
pres.defineSlideMaster({
  title: 'TCO Inhalt', background: { color: THEME.colors.lt1 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.45, w: 11.5, h: 0.9, fontSize: 32, bold: true, color: C.text1, margin: 0, align: 'left', valign: 'middle' }, text: 'Titel' } },
    ...fuss(false),
  ],
  slideNumber: { x: 11.4, y: 6.92, w: 0.6, h: 0.3, fontSize: 10, color: THEME.colors.accent3 },
});

// ---------- 1 Titel
pres.addSection({ title: 'Einstieg' });
let s = pres.addSlide({ masterName: 'TCO Titel', sectionTitle: 'Einstieg' });
s.addText('{{praesentation.titel}}', { placeholder: 'title' });
s.addText('{{praesentation.untertitel}} · {{stand.datum}}', { placeholder: 'body' });
s.addNotes('Titelfolie. Platzhalter in doppelten geschweiften Klammern füllt das Portal beim Erstellen; übriger Text bleibt, wie er ist.');

// ---------- 2 Kennzahlen auf einen Blick
pres.addSection({ title: 'Kennzahlen' });
s = pres.addSlide({ masterName: 'TCO Inhalt', sectionTitle: 'Kennzahlen' });
s.addText('Der Verein auf einen Blick', { placeholder: 'title' });
const kacheln = ['MTG_GESAMT', 'FIN_SALDO', 'HAL_BELEGUNG', 'JUG_MITGL'];
kacheln.forEach((k, i) => {
  const x = 0.6 + i * 3.05;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.75, w: 2.8, h: 2.6, fill: { color: C.background2 }, line: { type: 'none' }, rectRadius: 0.12, objectName: `Kachel ${i + 1}` });
  s.addText([{ text: `{{${k}}}`, options: { fontSize: 28, bold: true } }, { text: ` {{${k}.einheit}}`, options: { fontSize: 14 } }],
    { x: x + 0.25, y: 2.0, w: 2.3, h: 1.0, color: C.accent1, margin: 0, isTextBox: true, valign: 'middle' });
  s.addText(`{{${k}.titel}}`, { x: x + 0.25, y: 3.05, w: 2.3, h: 0.45, fontSize: 16, bold: true, color: C.text1, margin: 0, isTextBox: true });
  s.addText(`{{${k}.text}}`, { x: x + 0.25, y: 3.5, w: 2.3, h: 0.7, fontSize: 11, color: C.accent3, margin: 0, isTextBox: true, valign: 'top' });
});
s.addText('{{kommentar.ueberblick}}', { x: 0.6, y: 4.75, w: 11.9, h: 1.6, fontSize: 16, color: C.text2, margin: 0, isTextBox: true, valign: 'top' });
s.addNotes('Vier Kennzahlen aus der Vereinsübersicht: Schlüssel = Wert, Schlüssel.text = Untertitel, .titel, .einheit (z. B. MTG_GESAMT, FIN_SALDO, HAL_BELEGUNG, JUG_MITGL). Jede Kachel ist austauschbar.');

// ---------- 3 Diagramm + Kommentar (Mitgliederentwicklung)
s = pres.addSlide({ masterName: 'TCO Inhalt', sectionTitle: 'Kennzahlen' });
s.addText('Mitgliederentwicklung {{jahr}}', { placeholder: 'title' });
const monate = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
s.addChart(pres.charts.LINE, [{ name: 'Mitglieder', labels: monate, values: [312, 314, 318, 325, 331, 333, 334, 333, 336, 338, 340, 341] }], {
  x: 0.6, y: 1.55, w: 7.6, h: 4.9, objectName: '{{DIAGRAMM:MTG_MONATE}}',
  chartColors: [THEME.colors.accent1], lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 7,
  showLegend: false, showTitle: false, catAxisLabelColor: THEME.colors.accent3, valAxisLabelColor: THEME.colors.accent3,
  catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
  valGridLine: { color: 'E3E3E3', size: 1 }, catGridLine: { style: 'none' },
});
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 8.6, y: 1.55, w: 3.9, h: 4.9, fill: { color: C.background2 }, line: { type: 'none' }, rectRadius: 0.12, objectName: 'Kommentar' });
s.addText([
  { text: '{{MTG_EINTRITT}}', options: { fontSize: 28, bold: true, color: C.accent5, breakLine: true } },
  { text: 'Eintritte', options: { fontSize: 14, color: C.text2, breakLine: true } },
  { text: ' ', options: { fontSize: 10, breakLine: true } },
  { text: '{{MTG_AUSTRITT}}', options: { fontSize: 28, bold: true, color: C.accent6, breakLine: true } },
  { text: 'Austritte', options: { fontSize: 14, color: C.text2 } },
], { x: 8.9, y: 1.85, w: 3.3, h: 2.4, margin: 0, isTextBox: true, valign: 'top' });
s.addText('{{kommentar.mitglieder}}', { x: 8.9, y: 4.55, w: 3.3, h: 1.7, fontSize: 14, color: C.text2, margin: 0, isTextBox: true, valign: 'top' });
s.addNotes('Diagramm mit Beispieldaten: Das Portal ersetzt die Datenreihe beim Export durch die echten Monatswerte (Vereinsübersicht → Mitgliederentwicklung).');

// ---------- 4 Finanzen: Säulen Einnahmen/Ausgaben
pres.addSection({ title: 'Finanzen' });
s = pres.addSlide({ masterName: 'TCO Kapitel', sectionTitle: 'Finanzen' });
s.addText('Finanzen {{jahr}}', { placeholder: 'title' });
s.addText('Einnahmen, Ausgaben, Liquidität', { placeholder: 'body' });

s = pres.addSlide({ masterName: 'TCO Inhalt', sectionTitle: 'Finanzen' });
s.addText('Einnahmen und Ausgaben je Monat', { placeholder: 'title' });
s.addChart(pres.charts.BAR, [
  { name: 'Einnahmen', labels: monate, values: [9800, 4200, 3900, 5200, 4800, 3600, 7100, 2900, 3300, 4100, 3800, 5600] },
  { name: 'Ausgaben', labels: monate, values: [5100, 4600, 3800, 4400, 5200, 3900, 4100, 3500, 3700, 4900, 4300, 6100] },
], {
  x: 0.6, y: 1.55, w: 8.3, h: 4.9, barDir: 'col', barGapWidthPct: 60, objectName: '{{DIAGRAMM:FIN_MONATE}}',
  chartColors: [THEME.colors.accent5, THEME.colors.accent1], showLegend: true, legendPos: 'b', legendFontFace: '+mn-lt', legendFontSize: 11, legendColor: THEME.colors.accent3,
  catAxisLabelColor: THEME.colors.accent3, valAxisLabelColor: THEME.colors.accent3, catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt',
  catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, valGridLine: { color: 'E3E3E3', size: 1 }, catGridLine: { style: 'none' }, valAxisLabelFormatCode: '#,##0',
});
const liq = [['Geldkonten', '{{liq.geld}} €'], ['+ Forderungen Clubhaus', '{{liq.forderung}} €'], ['+ Offene Rechnungen', '{{liq.rechnungen}} €'], ['+ Kredite', '{{liq.kredit}} €']];
s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 9.2, y: 1.55, w: 3.3, h: 4.9, fill: { color: C.background2 }, line: { type: 'none' }, rectRadius: 0.12, objectName: 'Liquidität' });
s.addText('Liquidität {{liq.monat}}', { x: 9.45, y: 1.8, w: 2.8, h: 0.45, fontSize: 16, bold: true, color: C.text1, margin: 0, isTextBox: true });
liq.forEach(([t, w], i) => {
  s.addText(t, { x: 9.45, y: 2.4 + i * 0.75, w: 2.8, h: 0.3, fontSize: 11, color: C.accent3, margin: 0, isTextBox: true });
  s.addText(w, { x: 9.45, y: 2.7 + i * 0.75, w: 2.8, h: 0.35, fontSize: 15, bold: true, color: C.text1, margin: 0, isTextBox: true });
});
s.addText('= {{liq.summe}} €', { x: 9.45, y: 5.55, w: 2.8, h: 0.5, fontSize: 20, bold: true, color: C.accent1, margin: 0, isTextBox: true });
s.addNotes('Beispieldaten; Export übernimmt Einnahmen/Ausgaben je Monat und die Liquidität (inkl. offener Rechnungen, #28) aus „Saldo Konten“.');

// ---------- 6 Tabelle (Halle)
pres.addSection({ title: 'Halle' });
s = pres.addSlide({ masterName: 'TCO Inhalt', sectionTitle: 'Halle' });
s.addText('Halle: Belegung und offene Stunden', { placeholder: 'title' });
const kopf = (t) => ({ text: t, options: { bold: true, color: THEME.colors.lt1, fill: { color: THEME.colors.accent1 } } });
s.addTable([
  [kopf('Bereich'), kopf('Stand'), kopf('Anzahl'), kopf('Stunden'), kopf('Betrag')],
  ['Buchungen ohne Rechnung', 'bereits gespielt', '12', '18,5', '370,00'],
], { x: 0.6, y: 1.6, w: 12.1, colW: [3.6, 2.6, 1.6, 1.8, 2.5], fontSize: 12, objectName: '{{TABELLE:HAL_ABR}}', color: THEME.colors.dk1, border: { type: 'solid', pt: 0.75, color: 'E3E3E3' }, rowH: 0.36, valign: 'middle', margin: 0.08 });
s.addText('{{kommentar.halle}}', { x: 0.6, y: 5.6, w: 12.1, h: 1.0, fontSize: 16, color: C.text2, margin: 0, isTextBox: true, valign: 'top' });

// ---------- 7 Abschluss
pres.addSection({ title: 'Abschluss' });
s = pres.addSlide({ masterName: 'TCO Titel', sectionTitle: 'Abschluss' });
s.addText('Vielen Dank', { placeholder: 'title' });
s.addText('{{verein.name}}', { placeholder: 'body' });

(async () => {
  await pres.writeFile({ fileName: ZIEL });
  await applyTheme(ZIEL, THEME);
})();
