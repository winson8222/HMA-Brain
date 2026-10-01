// A tiny PDF writer for demo data (seed:drive): pages of plain text, "## " lines as bold headings. ASCII only.
// Just enough to give the connector a real PDF to extract, without a PDF library.

const WIDTH = 612; // US Letter, in points
const HEIGHT = 792;
const MARGIN = 72;
const LINES_PER_PAGE = 46;
const WRAP = 88; // characters per line at 11pt Helvetica, roughly

function wrap(paragraph: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > WRAP) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  out.push(line);
  return out;
}

const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

export function textPdf(body: string): Buffer {
  // Paragraphs → wrapped lines; headings keep their own line.
  const lines: { text: string; bold: boolean }[] = [];
  for (const para of body.split(/\n/)) {
    if (para.startsWith("## ")) lines.push({ text: "", bold: false }, { text: para.slice(3), bold: true });
    else for (const l of wrap(para)) lines.push({ text: l, bold: false });
  }
  const pages: (typeof lines)[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 page tree, 3 regular font, 4 bold font, then a page + content stream per page.
  const objects: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((page, i) => {
    const ops = page.map((l) => `${l.bold ? "/F2 13" : "/F1 11"} Tf ${pdfString(l.text)} Tj T*`).join("\n");
    const stream = `BT\n16 TL\n${MARGIN} ${HEIGHT - MARGIN} Td\n${ops}\nET`;
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${WIDTH} ${HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
