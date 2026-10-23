import zlib from "node:zlib";

export interface ParseCvResult {
  text: string;
  sourceType: "pdf" | "docx" | "txt";
  method: "pdfreader" | "stream_fallback" | "mammoth" | "text";
}

/**
 * Pure Node.js fallback to extract text from PDF streams when pdfreader/pdf2json fails or times out.
 * Reads FlateDecode compressed streams, unzips them with zlib, and extracts text operators (Tj / TJ / BT..ET).
 */
export function extractPdfTextFallback(buffer: Buffer): string {
  const content = buffer.toString("binary");
  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  const chunks: string[] = [];

  while ((match = streamRegex.exec(content)) !== null) {
    const rawStream = Buffer.from(match[1], "binary");
    let decompressed: string | null = null;
    try {
      decompressed = zlib.inflateSync(rawStream).toString("latin1");
    } catch {
      try {
        decompressed = zlib.inflateRawSync(rawStream).toString("latin1");
      } catch {
        decompressed = rawStream.toString("latin1");
      }
    }

    if (decompressed && (decompressed.includes("Tj") || decompressed.includes("TJ") || decompressed.includes("BT"))) {
      // Decode escaped PDF strings: \( -> (, \) -> ), \\ -> \
      const decodePdfString = (str: string) =>
        str
          .replace(/\\([()\\])/g, "$1")
          .replace(/\\r/g, "\r")
          .replace(/\\n/g, "\n")
          .replace(/\\t/g, "\t")
          .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

      // Match (string) Tj
      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = tjRegex.exec(decompressed)) !== null) {
        chunks.push(decodePdfString(m[1]));
      }

      // Match [(str) 10 (str)] TJ
      const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
      while ((m = tjArrayRegex.exec(decompressed)) !== null) {
        const inner = m[1];
        const innerRegex = /\(([^)]*)\)/g;
        let im: RegExpExecArray | null;
        let line = "";
        while ((im = innerRegex.exec(inner)) !== null) {
          line += decodePdfString(im[1]);
        }
        if (line) chunks.push(line);
      }

      // Match hex strings <48656C6C6F> Tj
      const hexTjRegex = /<([0-9A-Fa-f\s]+)>\s*Tj/g;
      while ((m = hexTjRegex.exec(decompressed)) !== null) {
        const hex = m[1].replace(/\s+/g, "");
        if (hex.length >= 2 && hex.length % 2 === 0) {
          try {
            chunks.push(Buffer.from(hex, "hex").toString("utf-8"));
          } catch {
            // ignore malformed hex
          }
        }
      }
    }
  }

  // If no streams contained text operators, check for plain uncompressed ASCII/UTF-8 strings
  if (chunks.length === 0) {
    const rawMatches = content.match(/\(([^)]{4,})\)/g);
    if (rawMatches) {
      for (const rm of rawMatches) {
        chunks.push(rm.slice(1, -1));
      }
    }
  }

  return normalizeExtractedText(chunks.join(" "));
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/[\t\u00a0]+/g, " ")
    .replace(/ +/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isTextSufficient(text: string): boolean {
  // At least 20 letters or digits
  const alphaNumeric = text.replace(/[^\p{L}\p{N}]/gu, "");
  return alphaNumeric.length >= 20;
}

/**
 * Robust PDF parsing with timeout and fallback.
 */
export async function parsePdfBuffer(buffer: Buffer, timeoutMs = 8000): Promise<{ text: string; method: "pdfreader" | "stream_fallback" }> {
  // Strategy 1: Attempt standard pdfreader with AbortController and strict timeout
  try {
    const pdfreaderModule = await import("pdfreader");
    const PdfReader = pdfreaderModule.PdfReader || (pdfreaderModule as any).default?.PdfReader;
    if (PdfReader) {
      const abortController = new AbortController();
      let timer: NodeJS.Timeout | null = null;

      const pdfreaderPromise = new Promise<string>((resolve, reject) => {
        const items: Array<{ page: number; x: number; y: number; w: number; sw: number; text: string }> = [];
        let reader: any;
        try {
          reader = new PdfReader({ signal: abortController.signal });
        } catch {
          reader = new PdfReader();
        }

        reader.parseBuffer(buffer, (err: any, item: any) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err?.parserError || err || "pdfreader_error")));
          } else if (!item) {
            items.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
            const lines: Array<{ page: number; y: number; items: typeof items }> = [];
            for (const fragment of items) {
              let line = lines[lines.length - 1];
              if (!line || line.page !== fragment.page || Math.abs(line.y - fragment.y) > 0.35) {
                line = { page: fragment.page, y: fragment.y, items: [] };
                lines.push(line);
              }
              line.items.push(fragment);
            }
            const content = lines
              .map((line) => {
                let previous: typeof items[number] | undefined;
                return line.items
                  .map((fragment) => {
                    const gap = previous ? fragment.x - (previous.x + previous.w) : 0;
                    const needsSpace = previous && gap > Math.max(0.25, previous.sw * 0.45);
                    previous = fragment;
                    return `${needsSpace ? " " : ""}${fragment.text}`;
                  })
                  .join("");
              })
              .join("\n");
            resolve(content);
          } else if (item.text) {
            items.push({
              page: Number(item.page || 1),
              x: Number(item.x || 0),
              y: Number(item.y || 0),
              w: Number(item.w || 0),
              sw: Number(item.sw || 0.25),
              text: String(item.text),
            });
          }
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { abortController.abort(); } catch {}
          reject(new Error("pdfreader_timeout"));
        }, timeoutMs);
      });

      try {
        const extracted = await Promise.race([pdfreaderPromise, timeoutPromise]);
        const normalized = normalizeExtractedText(extracted);
        if (isTextSufficient(normalized)) {
          return { text: normalized, method: "pdfreader" };
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (err) {
    console.warn(`[cvParser] pdfreader failed or timed out (${(err as Error).message}), attempting stream fallback...`);
  }

  // Strategy 2: Pure Node stream decompressed text extraction
  const fallbackText = extractPdfTextFallback(buffer);
  if (isTextSufficient(fallbackText)) {
    return { text: fallbackText, method: "stream_fallback" };
  }

  throw new Error("insufficient_extracted_text");
}

/**
 * Universal CV parser supporting PDF, DOCX, and TXT buffers.
 */
export async function parseCvFile(
  fileName: string,
  fileType: string,
  buffer: Buffer
): Promise<ParseCvResult> {
  const lowerFileName = fileName.toLowerCase();

  if (fileType === "application/pdf" || lowerFileName.endsWith(".pdf")) {
    const { text, method } = await parsePdfBuffer(buffer);
    return { text, sourceType: "pdf", method };
  }

  if (
    fileType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerFileName.endsWith(".docx")
  ) {
    const mammothModule = await import("mammoth");
    const mammoth = mammothModule.default || mammothModule;
    const result = await mammoth.extractRawText({ buffer });
    const normalized = normalizeExtractedText(result.value || "");
    if (!isTextSufficient(normalized)) {
      throw new Error("insufficient_extracted_text");
    }
    return { text: normalized, sourceType: "docx", method: "mammoth" };
  }

  if (fileType === "text/plain" || lowerFileName.endsWith(".txt")) {
    const normalized = normalizeExtractedText(buffer.toString("utf-8"));
    if (!isTextSufficient(normalized)) {
      throw new Error("insufficient_extracted_text");
    }
    return { text: normalized, sourceType: "txt", method: "text" };
  }

  throw new Error("unsupported_file_type");
}
