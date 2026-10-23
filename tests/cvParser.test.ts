import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  extractPdfTextFallback,
  normalizeExtractedText,
  isTextSufficient,
  parseCvFile,
  parsePdfBuffer,
} from "../src/cvParser.js";

test("normalizeExtractedText cleans redundant whitespace and preserves paragraphs", () => {
  const raw = "  Hello \t world \u00a0\n \n \n\nNext line   ";
  const result = normalizeExtractedText(raw);
  assert.equal(result, "Hello world\n\nNext line");
});

test("isTextSufficient requires at least 20 letters or digits", () => {
  assert.equal(isTextSufficient("123"), false);
  assert.equal(isTextSufficient("   --- !!! ...   "), false);
  assert.equal(isTextSufficient("Software Engineer with 5 years experience"), true);
});

test("extractPdfTextFallback extracts text from uncompressed PDF stream", () => {
  const pdfSource = `%PDF-1.4
1 0 obj << /Length 50 >> stream
BT /F1 12 Tf (Jane Doe Senior Product Manager Experience) Tj ET
endstream
endobj
%%EOF`;
  const buffer = Buffer.from(pdfSource, "binary");
  const extracted = extractPdfTextFallback(buffer);
  assert.match(extracted, /Jane Doe Senior Product Manager Experience/);
});

test("extractPdfTextFallback extracts text from FlateDecode compressed PDF stream", () => {
  const streamContent = "BT /F1 12 Tf (Rakshit Raj Product Intern SQL Python Figma) Tj ET";
  const compressed = zlib.deflateSync(Buffer.from(streamContent, "utf-8"));

  const header = Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode /Length " + compressed.length + " >> stream\r\n", "binary");
  const footer = Buffer.from("\r\nendstream\nendobj\n%%EOF", "binary");
  const buffer = Buffer.concat([header, compressed, footer]);

  const extracted = extractPdfTextFallback(buffer);
  assert.match(extracted, /Rakshit Raj Product Intern SQL Python Figma/);
});

test("extractPdfTextFallback extracts text from TJ arrays with hex and escapes", () => {
  const streamContent = "BT /F1 12 Tf [(Associate ) 10 (Product ) 20 (Manager)] TJ ET";
  const compressed = zlib.deflateSync(Buffer.from(streamContent, "utf-8"));

  const header = Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> stream\r\n", "binary");
  const footer = Buffer.from("\r\nendstream\nendobj\n%%EOF", "binary");
  const buffer = Buffer.concat([header, compressed, footer]);

  const extracted = extractPdfTextFallback(buffer);
  assert.match(extracted, /Associate Product Manager/);
});

test("parseCvFile successfully parses plain text CVs", async () => {
  const content = "Full Name: Alice Smith\nRole: Lead Engineer\nSkills: TypeScript, Node.js, PostgreSQL";
  const buffer = Buffer.from(content, "utf-8");
  const result = await parseCvFile("resume.txt", "text/plain", buffer);
  assert.equal(result.sourceType, "txt");
  assert.match(result.text, /Alice Smith/);
  assert.match(result.text, /TypeScript/);
});

test("parseCvFile throws insufficient_extracted_text for tiny or blank files", async () => {
  const buffer = Buffer.from("Hi", "utf-8");
  await assert.rejects(
    () => parseCvFile("resume.txt", "text/plain", buffer),
    /insufficient_extracted_text/
  );
});

test("parseCvFile throws unsupported_file_type for unrecognized extensions", async () => {
  const buffer = Buffer.from("Some content here that is long enough", "utf-8");
  await assert.rejects(
    () => parseCvFile("resume.png", "image/png", buffer),
    /unsupported_file_type/
  );
});

test("parsePdfBuffer falls back safely on corrupted PDF without hanging", async () => {
  // A corrupted PDF buffer that causes standard parsers to fail or throw
  const brokenPdf = Buffer.from("%PDF-1.4\ncorrupted random bytes without xref or proper structure");
  await assert.rejects(
    () => parsePdfBuffer(brokenPdf, 200),
    /insufficient_extracted_text/
  );
});
