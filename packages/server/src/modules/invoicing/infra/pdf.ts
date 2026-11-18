import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { sar, type EInvoiceDocument } from '../domain/document.js';

const require = createRequire(import.meta.url);
/** IBM Plex Sans Arabic (the brand's typeface, brand/fonts), OFL: the package's complete WOFF files. */
const FONT_DIR = '@ibm/plex-sans-arabic/fonts/complete/woff';
const fontPath = (weight: 'Regular' | 'SemiBold') =>
  require.resolve(`${FONT_DIR}/IBMPlexSansArabic-${weight}.woff`);

/**
 * A WOFF 1.0 font as the plain sfnt (TrueType/OpenType) it wraps: every table inflated once with the native zlib
 * (W3C WOFF §4–§5). V2-051 (DEC-563): handed a WOFF, the layout engine re-inflates a table in pure JavaScript each
 * time it reads it — about 1.6 s of blocked event loop per invoice in the worker, three quarters of it in that
 * inflate (the V2 load profile); the sfnt renders the same glyphs.
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.toString('latin1', 0, 4) !== 'wOFF') throw new Error('not a WOFF 1.0 font');
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: { tag: number; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const offset = woff.readUInt32BE(e + 4);
    const compLength = woff.readUInt32BE(e + 8);
    const origLength = woff.readUInt32BE(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    if (data.length !== origLength) throw new Error('WOFF table length mismatch');
    tables.push({ tag: woff.readUInt32BE(e), checksum: woff.readUInt32BE(e + 16), data });
  }
  tables.sort((x, y) => x.tag - y.tag);
  let pow = 1;
  while (pow * 2 <= numTables) pow *= 2;
  const head = 12 + 16 * numTables;
  const size = tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), head);
  const out = Buffer.alloc(size);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(Math.log2(pow), 8);
  out.writeUInt16BE(numTables * 16 - pow * 16, 10);
  let at = head;
  tables.forEach((t, i) => {
    const r = 12 + i * 16;
    out.writeUInt32BE(t.tag, r);
    out.writeUInt32BE(t.checksum, r + 4);
    out.writeUInt32BE(at, r + 8);
    out.writeUInt32BE(t.data.length, r + 12);
    t.data.copy(out, at);
    at += (t.data.length + 3) & ~3;
  });
  return out;
}

/** The two weights of the invoice as sfnt buffers, decoded once per process. */
const fonts = new Map<string, Buffer>();
function font(weight: 'Regular' | 'SemiBold'): Buffer {
  let b = fonts.get(weight);
  if (!b) fonts.set(weight, (b = woffToSfnt(readFileSync(fontPath(weight)))));
  return b;
}

const ARABIC = /[\u{600}-\u{6ff}\u{750}-\u{77f}\u{8a0}-\u{8ff}\u{fb50}-\u{fdff}\u{fe70}-\u{fefe}]/u;
/** digits with their terminators (`15%`, `+3`) stay one left-to-right run */
const LATIN_OR_DIGIT = /[A-Za-z0-9\u{c0}-\u{24f}%+]/u;
const MIRROR: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '\u{ab}': '\u{bb}',
  '\u{bb}': '\u{ab}',
};

export interface BidiRun {
  text: string;
  rtl: boolean;
}

/**
 * Splits a line of an RTL paragraph into directional runs in logical order (a small subset of the Unicode bidi
 * algorithm, enough for invoice text): Arabic letters make RTL runs, Latin letters and digits LTR runs, and neutral
 * characters (spaces, punctuation) join an LTR run only when both neighbours are LTR, else the RTL paragraph.
 */
export function bidiRuns(text: string): BidiRun[] {
  const chars = [...text];
  const strong = chars.map((c) => (ARABIC.test(c) ? 'R' : LATIN_OR_DIGIT.test(c) ? 'L' : 'N'));
  const types = strong.map((t, i) => {
    if (t !== 'N') return t;
    let prev = 'R';
    for (let j = i - 1; j >= 0; j--)
      if (strong[j] !== 'N') {
        prev = strong[j]!;
        break;
      }
    let next = 'R';
    for (let j = i + 1; j < strong.length; j++)
      if (strong[j] !== 'N') {
        next = strong[j]!;
        break;
      }
    return prev === 'L' && next === 'L' ? 'L' : 'R';
  });
  const runs: BidiRun[] = [];
  chars.forEach((c, i) => {
    const rtl = types[i] === 'R';
    const last = runs[runs.length - 1];
    if (last && last.rtl === rtl) last.text += c;
    else runs.push({ text: c, rtl });
  });
  return runs;
}

type Doc = PDFKit.PDFDocument;

/**
 * Draws one line of right-to-left text ending at `right`: the runs are laid from right to left in logical order.
 * The layout engine shapes and reverses each Arabic run itself (it sees an RTL script), so an RTL run is handed over
 * as one unbreakable piece (spaces → no-break spaces, mirrored brackets) and an LTR run as is.
 */
export function drawRtl(
  doc: Doc,
  text: string,
  right: number,
  y: number,
  font: string,
  size: number,
): number {
  doc.font(font).fontSize(size);
  let x = right;
  // a text with no Arabic letter is one left-to-right run (a Latin name keeps its final full stop on the right)
  const runs = ARABIC.test(text) ? bidiRuns(text) : [{ text, rtl: false }];
  for (const run of runs) {
    const t = run.rtl
      ? [...run.text].map((c) => MIRROR[c] ?? (c === ' ' ? '\u{a0}' : c)).join('')
      : run.text.replace(/ /g, '\u{a0}');
    const w = doc.widthOfString(t);
    x -= w;
    doc.text(t, x, y, { lineBreak: false });
  }
  return right - x;
}

const TITLES: Record<string, { ar: string; en: string }> = {
  customer_simplified: { ar: 'فاتورة ضريبية مبسطة', en: 'Simplified Tax Invoice' },
  operator_standard: { ar: 'فاتورة ضريبية', en: 'Tax Invoice' },
  credit_note: { ar: 'إشعار دائن', en: 'Credit Note' },
};

const riyadh = (iso: string) => {
  const d = new Date(Date.parse(iso) + 3 * 3_600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
};

export interface PdfOptions {
  /** printed across the page outside production: the simulator reported nothing to ZATCA */
  simulated: boolean;
  /** the QR to print: the provider's stamped one when it answered, else POINT's tags 1–5 */
  qr: string;
  status: string;
}

/**
 * Renders an invoice or credit note as an A4 PDF (V2-040, DEC-548): Arabic first, right to left, with the English
 * labels beside, the seller and buyer blocks, the lines with their VAT apart, the totals and the ZATCA QR. Server
 * side, in the worker (`job.invoice_pdf_render`), never inside a transaction.
 */
export async function renderInvoicePdf(d: EInvoiceDocument, o: PdfOptions): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `${d.number}`, Producer: 'invoicing', Creator: 'invoicing' },
  });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  pdf.registerFont('r', font('Regular'));
  pdf.registerFont('b', font('SemiBold'));
  const L = 40;
  const R = 555;
  const title = TITLES[d.kind] ?? TITLES.customer_simplified!;

  if (o.simulated) {
    pdf.save();
    pdf.rotate(-30, { origin: [300, 640] });
    pdf.fillColor('#d8d8d8');
    drawRtl(pdf, 'نسخة تجريبية — لم تُرسل إلى الهيئة', 500, 620, 'b', 26);
    pdf.restore();
    pdf.fillColor('#000000');
  }

  drawRtl(pdf, title.ar, R, 40, 'b', 20);
  pdf.font('r').fontSize(11).text(title.en, L, 46, { lineBreak: false });

  let y = 84;
  const row = (labelAr: string, labelEn: string, value: string, bold = false) => {
    drawRtl(pdf, labelAr, R, y, 'b', 10);
    pdf
      .font('r')
      .fontSize(9)
      .fillColor('#555555')
      .text(labelEn, L, y + 1, { lineBreak: false });
    pdf.fillColor('#000000');
    drawRtl(pdf, value, R - 150, y, bold ? 'b' : 'r', 10);
    y += 18;
  };
  row('رقم الفاتورة', 'Invoice number', d.number, true);
  row('تاريخ الإصدار', 'Issue date', riyadh(d.issuedAt));
  row('تاريخ التوريد', 'Supply date', d.supplyDate);
  row('المعرف الفريد', 'UUID', d.uuid);
  row('حالة الإرسال', 'Status', o.status);
  if (d.original) {
    row('الفاتورة الأصلية', 'Original invoice', d.original.number);
    row('سبب الإشعار', 'Reason', d.creditReason ?? '');
  }
  if (d.periodStart && d.periodEnd) row('الفترة', 'Period', `${d.periodStart} — ${d.periodEnd}`);

  y += 8;
  drawRtl(pdf, 'البائع', R, y, 'b', 12);
  pdf
    .font('r')
    .fontSize(9)
    .text('Seller', L, y + 2, { lineBreak: false });
  y += 20;
  row('الاسم', 'Name', d.seller.legal_name_ar);
  if (d.seller.legal_name_en) row('الاسم بالإنجليزية', 'Name (EN)', d.seller.legal_name_en);
  row('الرقم الضريبي', 'VAT number', d.seller.vat_number);
  row('السجل التجاري', 'CR number', d.seller.cr_number);
  row('العنوان', 'Address', d.seller.address_ar);
  if (d.buyer.kind === 'consumer' && d.buyer.venue_name_ar) {
    row('مكان الخدمة', 'Place of service', d.buyer.venue_name_ar);
    if (d.buyer.operator_name_ar) row('التشغيل', 'Operated by', d.buyer.operator_name_ar);
  }
  if (d.buyer.kind === 'operator') {
    y += 8;
    drawRtl(pdf, 'المشتري', R, y, 'b', 12);
    pdf
      .font('r')
      .fontSize(9)
      .text('Buyer', L, y + 2, { lineBreak: false });
    y += 20;
    row('الاسم', 'Name', d.buyer.legal_name_ar ?? '');
    if (d.buyer.vat_number) row('الرقم الضريبي', 'VAT number', d.buyer.vat_number);
    if (d.buyer.cr_number) row('السجل التجاري', 'CR number', d.buyer.cr_number);
  }

  y += 10;
  pdf.moveTo(L, y).lineTo(R, y).strokeColor('#999999').stroke();
  y += 6;
  // columns, right to left: description | net | VAT | total
  const cols = { desc: R, net: 250, vat: 170, total: 90 };
  drawRtl(pdf, 'البيان', cols.desc, y, 'b', 10);
  drawRtl(pdf, 'الصافي', cols.net, y, 'b', 10);
  drawRtl(pdf, 'الضريبة', cols.vat, y, 'b', 10);
  drawRtl(pdf, 'الإجمالي', cols.total, y, 'b', 10);
  y += 18;
  for (const l of d.lines) {
    drawRtl(pdf, l.description_ar, cols.desc, y, 'r', 10);
    drawRtl(pdf, sar(l.net_halalas), cols.net, y, 'r', 10);
    drawRtl(pdf, sar(l.vat_halalas), cols.vat, y, 'r', 10);
    drawRtl(pdf, sar(l.total_halalas), cols.total, y, 'r', 10);
    y += 14;
    pdf.font('r').fontSize(8).fillColor('#555555').text(l.description_en, L, y, { lineBreak: false });
    pdf.fillColor('#000000');
    y += 16;
    if (y > 640) {
      pdf.addPage();
      y = 60;
    }
  }
  pdf.moveTo(L, y).lineTo(R, y).strokeColor('#999999').stroke();
  y += 10;
  row('الإجمالي غير شامل الضريبة (ريال)', 'Total excluding VAT (SAR)', sar(d.subtotalHalalas));
  row(`ضريبة القيمة المضافة ${d.vatRateBp / 100}%`, 'VAT', sar(d.vatHalalas));
  row('الإجمالي شامل الضريبة (ريال)', 'Total including VAT (SAR)', sar(d.totalHalalas), true);

  const png = await QRCode.toBuffer(o.qr, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
  const qrY = Math.min(Math.max(y + 10, 600), 700);
  pdf.image(png, L, qrY, { width: 110 });
  pdf.end();
  return done;
}
