import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runJobMatcher } from "./runner.js";

// Set DOMMatrix polyfill for pdf-parse (needed in Node environment)
if (typeof (global as any).DOMMatrix === "undefined") {
  (global as any).DOMMatrix = class DOMMatrix {};
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const publicDir = path.join(__dirname, "..", "public");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(publicDir));

// Initial data endpoint to prefill the UI forms
app.get("/api/initial-data", (req, res) => {
  try {
    const cvPath = path.join(dataDir, "cv.txt");
    const profilePath = path.join(dataDir, "profile.json");
    const companiesPath = path.join(dataDir, "companies.json");

    const cvText = existsSync(cvPath) ? readFileSync(cvPath, "utf-8") : "";
    const profile = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf-8")) : null;
    const companies = existsSync(companiesPath) ? JSON.parse(readFileSync(companiesPath, "utf-8")) : null;

    res.json({ cvText, profile, companies });
  } catch (error) {
    res.status(500).json({ error: "Failed to read initial config files: " + (error as Error).message });
  }
});

// CV parsing endpoint to handle PDF, DOCX, and TXT files
app.post("/api/upload-cv", async (req, res) => {
  try {
    const { fileName, fileType, fileData } = req.body;
    if (!fileData) {
      res.status(400).json({ error: "Missing file data" });
      return;
    }

    const buffer = Buffer.from(fileData, "base64");
    let text = "";

    if (fileType === "application/pdf" || fileName.endsWith(".pdf")) {
      const pdfParseModule = await import("pdf-parse");
      const parsePdf = typeof pdfParseModule === "function"
        ? pdfParseModule
        : (pdfParseModule as any).PDFParse || (pdfParseModule as any).default;

      const data = await parsePdf(buffer);
      text = data.text || "";
    } else if (
      fileType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      fileName.endsWith(".docx")
    ) {
      const mammothModule = await import("mammoth");
      const mammoth = mammothModule.default || mammothModule;
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || "";
    } else if (fileType === "text/plain" || fileName.endsWith(".txt")) {
      text = buffer.toString("utf-8");
    } else {
      res.status(400).json({ error: "Unsupported file type. Please upload a PDF, DOCX, or TXT file." });
      return;
    }

    res.json({ text: text.trim() });
  } catch (error) {
    res.status(500).json({ error: "Failed to parse file: " + (error as Error).message });
  }
});

// SSE endpoint to run the matcher and stream progress updates
app.post("/api/match", async (req, res) => {
  const { cvText, profile, companies, linkedin } = req.body;

  if (!cvText || !profile || !companies) {
    res.status(400).json({ error: "Missing required fields (cvText, profile, or companies)" });
    return;
  }

  // Setup Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const scoredMatches = await runJobMatcher({
      cvText,
      profile,
      companies,
      linkedin,
      onProgress: (status, message) => {
        sendEvent("progress", { status, message });
      },
    });

    sendEvent("done", { results: scoredMatches });
  } catch (error) {
    console.error("Match error:", error);
    sendEvent("error", { message: (error as Error).message });
  } finally {
    res.end();
  }
});

// Catch-all route to serve the frontend
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

if (process.env.NODE_ENV !== "production" || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
  });
}

export default app;
