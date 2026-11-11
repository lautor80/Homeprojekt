// Standardvorlage „Bausteine“ der App Präsentationen (#146): jede Folie ist ein Baustein, den das Portal je Eintrag
// des Sammelkorbs klont und füllt. Marker in Objektnamen: {{DIAGRAMM}}, {{TABELLE}}; Kacheln heißen „Kachel 1“ … „Kachel 4“.
const pptxgen = require('pptxgenjs');
const { applyTheme } = require(process.env.APPLY_THEME || './apply_theme.js');
const fs = require('fs');
const path = require('path');
const ASSETS = process.env.ASSETS || path.join(__dirname, '..', '..', 'modules', 'tco', 'server', 'assets');
const ZIEL = process.argv[2] || 'praesentation_standard.pptx';
const THEME = {
  name: 'TC Oberthal', headFontFace: 'Arial', bodyFontFace: 'Arial',
  colors: { dk1: '1F1F1F', lt1: 'FFFFFF', dk2: '3A3A3A', lt2: 'F6F4F2', accent1: 'E2701F', accent2: '2E7D32', accent3: '6B6B6B',
    accent4: 'F2A66B', accent5: '2E7D32', accent6: 'C62828', hlink: 'B9561A', folHlink: '6B6B6B' },
};
const img = (f) => 'image/png;base64,' + fs.readFileSync(path.join(ASSETS, f)).toString('base64');
const LOGO_W = img('logo_weiss.png'), LOGO_O = img('logo_orange.png');
const LR = 487 / 800;
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
pres.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial' };
pres.title = 'TC Oberthal – Präsentation';
pres.author = 'TC Oberthal';
pres.company = 'TC Oberthal';
const C = pres.SchemeColor;
const fuss = (dunkel) => [
  { image: { x: 12.15, y: 6.85, w: 0.75, h: 0.75 * LR, data: dunkel ? LOGO_W : LOGO_O } },
  { text: { text: '{{verein.name}} · {{praesentation.titel}} · Stand {{stand.datum}}', options: { x: 0.6, y: 6.9, w: 9, h: 0.35, fontSize: 10, color: dunkel ? C.background1 : C.accent3, margin: 0 } } },
];
pres.defineSlideMaster({ title: 'TCO Titel', background: { color: THEME.colors.accent1 }, objects: [
  { image: { x: 0.6, y: 0.6, w: 2.2, h: 2.2 * LR, data: LOGO_W } },
  { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 2.6, w: 11, h: 1.6, fontSize: 44, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: 'Titel' } },
  { placeholder: { options: { name: 'body', type: 'body', x: 0.6, y: 4.35, w: 11, h: 1.2, fontSize: 20, color: C.background1, valign: 'top', align: 'left', margin: 0 }, text: 'Untertitel' } },
] });
pres.defineSlideMaster({ title: 'TCO Kapitel', background: { color: THEME.colors.dk1 }, objects: [
  { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 2.5, w: 10, h: 1.4, fontSize: 40, bold: true, color: C.background1, align: 'left', margin: 0 }, text: 'Kapitel' } },
  { placeholder: { options: { name: 'body', type: 'body', x: 0.6, y: 3.95, w: 10, h: 1, fontSize: 18, color: C.accent4, align: 'left', margin: 0 }, text: 'Worum es geht' } },
  ...fuss(true),
], slideNumber: { x: 11.4, y: 6.92, w: 0.6, h: 0.3, fontSize: 10, color: THEME.colors.lt1 } });
pres.defineSlideMaster({ title: 'TCO Inhalt', background: { color: THEME.colors.lt1 }, objects: [
  { placeholder: { options: { name: 'title', type: 'title', x: 0.6, y: 0.45, w: 11.5, h: 0.9, fontSize: 32, bold: true, color: C.text1, margin: 0, align: 'left', valign: 'middle' }, text: 'Titel' } },
  ...fuss(false),
], slideNumber: { x: 11.4, y: 6.92, w: 0.6, h: 0.3, fontSize: 10, color: THEME.colors.accent3 } });

const chartOpt = (extra) => ({
  showTitle: false, catAxisLabelColor: THEME.colors.accent3, valAxisLabelColor: THEME.colors.accent3,
  catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt', catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
  valGridLine: { color: 'E3E3E3', size: 1 }, catGridLine: { style: 'none' },
  showLegend: true, legendPos: 'b', legendFontFace: '+mn-lt', legendFontSize: 11, legendColor: THEME.colors.accent3, valAxisLabelFormatCode: '#,##0', ...extra,
});
const monate = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const box = (s, x, y, w, h, name) => s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: C.background2 }, line: { type: 'none' }, rectRadius: 0.12, objectName: name });

// 1 TITEL
let s = pres.addSlide({ masterName: 'TCO Titel' });
s.addText('{{praesentation.titel}}', { placeholder: 'title' });
s.addText('{{praesentation.untertitel}} · {{stand.datum}}', { placeholder: 'body' });
// 2 KENNZAHLEN (bis zu vier)
s = pres.addSlide({ masterName: 'TCO Inhalt' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
for (let i = 1; i <= 4; i++) {
  const x = 0.6 + (i - 1) * 3.05;
  box(s, x, 1.75, 2.8, 2.6, `Kachel ${i}`);
  s.addText([{ text: `{{K${i}}}`, options: { fontSize: 28, bold: true } }, { text: ` {{K${i}.einheit}}`, options: { fontSize: 14, bold: false } }],
    { x: x + 0.25, y: 2.0, w: 2.3, h: 1.0, color: C.accent1, margin: 0, isTextBox: true, valign: 'middle', objectName: `Kachel ${i} Wert` });
  s.addText(`{{K${i}.titel}}`, { x: x + 0.25, y: 3.05, w: 2.3, h: 0.45, fontSize: 16, bold: true, color: C.text1, margin: 0, isTextBox: true, objectName: `Kachel ${i} Titel` });
  s.addText(`{{K${i}.text}}`, { x: x + 0.25, y: 3.5, w: 2.3, h: 0.7, fontSize: 11, color: C.accent3, margin: 0, isTextBox: true, valign: 'top', objectName: `Kachel ${i} Text` });
}
s.addText('{{folie.text}}', { x: 0.6, y: 4.75, w: 11.9, h: 1.6, fontSize: 16, color: C.text2, margin: 0, isTextBox: true, valign: 'top', objectName: 'Kommentar' });
// 3 LINIENDIAGRAMM
s = pres.addSlide({ masterName: 'TCO Inhalt' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
s.addChart(pres.charts.LINE, [
  { name: 'Reihe 1', labels: monate, values: [312, 314, 318, 325, 331, 333, 334, 333, 336, 338, 340, 341] },
  { name: 'Reihe 2', labels: monate, values: [300, 301, 303, 306, 310, 312, 313, 313, 314, 316, 318, 319] },
], { x: 0.6, y: 1.55, w: 8.3, h: 4.9, objectName: '{{DIAGRAMM}}', chartColors: [THEME.colors.accent1, THEME.colors.accent3], lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 6, ...chartOpt({}) });
box(s, 9.2, 1.55, 3.3, 4.9, 'Kommentar Hintergrund');
s.addText('{{folie.text}}', { x: 9.45, y: 1.8, w: 2.8, h: 4.4, fontSize: 14, color: C.text2, margin: 0, isTextBox: true, valign: 'top', objectName: 'Kommentar' });
// 4 SÄULENDIAGRAMM
s = pres.addSlide({ masterName: 'TCO Inhalt' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
s.addChart(pres.charts.BAR, [
  { name: 'Reihe 1', labels: monate, values: [9800, 4200, 3900, 5200, 4800, 3600, 7100, 2900, 3300, 4100, 3800, 5600] },
  { name: 'Reihe 2', labels: monate, values: [5100, 4600, 3800, 4400, 5200, 3900, 4100, 3500, 3700, 4900, 4300, 6100] },
], { x: 0.6, y: 1.55, w: 8.3, h: 4.9, barDir: 'col', barGapWidthPct: 60, objectName: '{{DIAGRAMM}}', chartColors: [THEME.colors.accent5, THEME.colors.accent1], ...chartOpt({}) });
box(s, 9.2, 1.55, 3.3, 4.9, 'Kommentar Hintergrund');
s.addText('{{folie.text}}', { x: 9.45, y: 1.8, w: 2.8, h: 4.4, fontSize: 14, color: C.text2, margin: 0, isTextBox: true, valign: 'top', objectName: 'Kommentar' });
// 5 TABELLE
s = pres.addSlide({ masterName: 'TCO Inhalt' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
const kopf = (t) => ({ text: t, options: { bold: true, color: THEME.colors.lt1, fill: { color: THEME.colors.accent1 } } });
s.addTable([[kopf('Spalte 1'), kopf('Spalte 2'), kopf('Spalte 3')], ['Wert', 'Wert', 'Wert']],
  { x: 0.6, y: 1.6, w: 12.1, colW: [4.0, 4.0, 4.1], fontSize: 12, color: THEME.colors.dk1, border: { type: 'solid', pt: 0.75, color: 'E3E3E3' }, rowH: 0.36, valign: 'middle', margin: 0.06, objectName: '{{TABELLE}}' });
s.addText('{{folie.text}}', { x: 0.6, y: 6.2, w: 12.1, h: 0.5, fontSize: 11, italic: true, color: C.accent3, margin: 0, isTextBox: true, objectName: 'Kommentar' });
// 6 TEXT
s = pres.addSlide({ masterName: 'TCO Inhalt' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
box(s, 0.6, 1.55, 12.1, 4.9, 'Text Hintergrund');
s.addText('{{folie.text}}', { x: 0.9, y: 1.85, w: 11.5, h: 4.3, fontSize: 18, color: C.text1, margin: 0, isTextBox: true, valign: 'top', objectName: 'Kommentar' });
// 7 KAPITEL
s = pres.addSlide({ masterName: 'TCO Kapitel' });
s.addText('{{folie.titel}}', { placeholder: 'title' });
s.addText('{{folie.text}}', { placeholder: 'body' });
// 8 ABSCHLUSS
s = pres.addSlide({ masterName: 'TCO Titel' });
s.addText('Vielen Dank', { placeholder: 'title' });
s.addText('{{verein.name}}', { placeholder: 'body' });
(async () => { await pres.writeFile({ fileName: ZIEL }); await applyTheme(ZIEL, THEME); })();
