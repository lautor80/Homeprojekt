import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/**
 * Kleine Zeichen-API in Millimetern (Ursprung oben links) – entspricht ZCL_EU_PDF.
 * Texte werden auf der Grundlinie (y) ausgerichtet. Schriften: Helvetica / Helvetica-Bold.
 */
const MM = 72 / 25.4;

export interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: string;
  align?: 'L' | 'R' | 'C';
}

export interface RectOpts {
  fill?: string;
  stroke?: string;
  lw?: number;
  radius?: number;
}

const hex = (c: string) => (c.startsWith('#') ? c : `#${c}`);

export interface PdfOptions {
  title?: string;
  author?: string;
  subject?: string;
  creator?: string;
  /**
   * PDF/A-3b (ISO 19005-3) erzeugen – Voraussetzung für ZUGFeRD/Factur-X. Erfordert eingebettete
   * Schriften (TrueType-Dateien für normal und fett); die 14 Standardschriften sind in PDF/A nicht erlaubt.
   */
  pdfa?: { regular: string; bold: string };
  /** Dokumentsprache (BCP 47), z. B. de-DE */
  lang?: string;
}

export class Pdf {
  readonly doc: PDFKit.PDFDocument;
  private chunks: Buffer[] = [];
  private done: Promise<Buffer>;
  private readonly pdfa: boolean;

  constructor(info: PdfOptions = {}) {
    this.pdfa = !!info.pdfa;
    this.doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: false,
      bufferPages: true,
      lang: info.lang ?? 'de-DE',
      ...(info.pdfa ? { subset: 'PDF/A-3b', pdfVersion: '1.7' } : {}),
      info: { Title: info.title, Author: info.author, Subject: info.subject, Creator: info.creator ?? 'Portalbasis' },
    } as ConstructorParameters<typeof PDFDocument>[0]);
    if (info.pdfa) {
      this.doc.registerFont('Sans', info.pdfa.regular);
      this.doc.registerFont('Sans-Bold', info.pdfa.bold);
    }
    this.done = new Promise((resolve) => {
      this.doc.on('data', (c: Buffer) => this.chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
    });
  }

  newPage() {
    this.doc.addPage({ size: 'A4', margin: 0 });
  }

  pageCount() {
    return this.doc.bufferedPageRange().count;
  }

  setPage(i: number) {
    this.doc.switchToPage(i);
  }

  private font(size = 9, bold = false) {
    const name = this.pdfa ? (bold ? 'Sans-Bold' : 'Sans') : bold ? 'Helvetica-Bold' : 'Helvetica';
    this.doc.font(name).fontSize(size);
  }

  /**
   * Datei einbetten (PDF/A-3: zugehörige Datei mit AFRelationship). Für ZUGFeRD/Factur-X:
   * name 'factur-x.xml', mime 'text/xml', relationship 'Alternative'.
   */
  anhang(data: Buffer, o: { name: string; mime: string; description?: string; relationship?: 'Alternative' | 'Data' | 'Source' | 'Supplement' | 'Unspecified'; datum?: Date }) {
    const d = o.datum ?? new Date();
    (this.doc as unknown as { file: (src: Buffer, opts: Record<string, unknown>) => void }).file(data, {
      name: o.name, type: o.mime, description: o.description, relationship: o.relationship ?? 'Unspecified', creationDate: d, modifiedDate: d,
    });
  }

  /** Zusätzliche XMP-Metadaten (RDF-Beschreibungen), z. B. das Factur-X-Erweiterungsschema */
  xmp(rdf: string) {
    (this.doc as unknown as { appendXML: (xml: string) => void }).appendXML(rdf);
  }

  textWidth(text: string, o: TextOpts = {}): number {
    this.font(o.size, o.bold);
    return this.doc.widthOfString(text) / MM;
  }

  text(x: number, y: number, text: string | null | undefined, o: TextOpts = {}) {
    if (!text) return;
    this.font(o.size, o.bold);
    let px = x;
    if (o.align === 'R') px = x - this.textWidth(text, o);
    else if (o.align === 'C') px = x - this.textWidth(text, o) / 2;
    this.doc.fillColor(hex(o.color ?? '1F2328'));
    this.doc.text(text, px * MM, y * MM, { lineBreak: false, baseline: 'alphabetic' });
  }

  /** Text mit Zeilenumbruch in einer Breite; liefert die verbrauchte Höhe in mm. */
  textBlock(x: number, y: number, w: number, text: string, o: TextOpts & { lineGap?: number } = {}): number {
    if (!text) return 0;
    this.font(o.size, o.bold);
    this.doc.fillColor(hex(o.color ?? '1F2328'));
    const opts = { width: w * MM, lineGap: (o.lineGap ?? 1) * MM, align: o.align === 'R' ? 'right' : 'left' } as const;
    const h = this.doc.heightOfString(text, opts);
    this.doc.text(text, x * MM, y * MM, opts);
    return h / MM;
  }

  blockHeight(w: number, text: string, o: TextOpts & { lineGap?: number } = {}): number {
    if (!text) return 0;
    this.font(o.size, o.bold);
    return this.doc.heightOfString(text, { width: w * MM, lineGap: (o.lineGap ?? 1) * MM }) / MM;
  }

  rect(x: number, y: number, w: number, h: number, o: RectOpts) {
    const d = this.doc;
    d.save();
    if (o.radius) d.roundedRect(x * MM, y * MM, w * MM, h * MM, o.radius * MM);
    else d.rect(x * MM, y * MM, w * MM, h * MM);
    if (o.lw) d.lineWidth(o.lw * MM);
    if (o.fill && o.stroke) d.fillAndStroke(hex(o.fill), hex(o.stroke));
    else if (o.fill) d.fill(hex(o.fill));
    else if (o.stroke) d.stroke(hex(o.stroke));
    d.restore();
  }

  line(x1: number, y1: number, x2: number, y2: number, color = 'E6E8EB', lw = 0.2) {
    this.doc.save().lineWidth(lw * MM).moveTo(x1 * MM, y1 * MM).lineTo(x2 * MM, y2 * MM).stroke(hex(color)).restore();
  }

  circle(cx: number, cy: number, r: number, fill: string) {
    this.doc.save().circle(cx * MM, cy * MM, r * MM).fill(hex(fill)).restore();
  }

  /** Bild (PNG/JPEG als Data-URL oder Buffer), eingepasst in w × h mm */
  image(img: string | Buffer, x: number, y: number, w: number, h: number) {
    let data: Buffer;
    if (typeof img === 'string') {
      const m = /^data:image\/(png|jpeg);base64,(.*)$/.exec(img);
      if (!m) return;
      data = Buffer.from(m[2], 'base64');
    } else data = img;
    this.doc.image(data, x * MM, y * MM, { fit: [w * MM, h * MM] });
  }

  /** QR-Code (Fehlerkorrektur M) als Vektorgrafik, Kantenlänge w mm */
  qr(text: string, x: number, y: number, w: number) {
    const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const m = w / n;
    const d = this.doc;
    d.save();
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (q.modules.get(r, c)) d.rect((x + c * m) * MM, (y + r * m) * MM, (m + 0.02) * MM, (m + 0.02) * MM);
      }
    }
    d.fill('#000000').restore();
  }

  async render(): Promise<Buffer> {
    this.doc.end();
    return this.done;
  }
}
