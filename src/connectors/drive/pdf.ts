// PDF → plain text (text layer only; scanned PDFs come out empty and are indexed by title).
import { extractText, getDocumentProxy } from "unpdf";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text);
  } finally {
    await pdf.cleanup();
  }
}
