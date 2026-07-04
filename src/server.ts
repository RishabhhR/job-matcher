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

// Cron endpoint to run the matcher periodically and email results
app.get("/api/cron-match", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const cvPath = path.join(dataDir, "cv.txt");
    const profilePath = path.join(dataDir, "profile.json");
    const companiesPath = path.join(dataDir, "companies.json");

    if (!existsSync(cvPath) || !existsSync(profilePath) || !existsSync(companiesPath)) {
      throw new Error("Configuration files (cv.txt, profile.json, companies.json) are missing from the data folder.");
    }

    const cvText = readFileSync(cvPath, "utf-8");
    const profile = JSON.parse(readFileSync(profilePath, "utf-8"));
    const companies = JSON.parse(readFileSync(companiesPath, "utf-8"));

    console.log("[cron] Starting job matching pipeline...");
    const logs: string[] = [];
    const onProgress = (status: string, message: string) => {
      logs.push(`[${status}] ${message}`);
      console.log(`[cron] ${status}: ${message}`);
    };

    const scoredMatches = await runJobMatcher({
      cvText,
      profile,
      companies,
      linkedin: {
        location: "India",
        maxResults: 10
      },
      onProgress
    });

    console.log(`[cron] Matcher complete. Found ${scoredMatches.length} scored matches.`);

    // Generate HTML digest
    let htmlContent = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937; line-height: 1.6;">
        <div style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); padding: 24px; border-radius: 8px 8px 0 0; color: #ffffff; text-align: center;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 700;">Job Match Digest</h1>
          <p style="margin: 8px 0 0 0; opacity: 0.9; font-size: 14px;">Ranked match openings for target title: <strong>${profile.targetDesignation}</strong></p>
        </div>
        <div style="padding: 24px; background: #fafafa; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    `;

    if (scoredMatches.length === 0) {
      htmlContent += `
        <div style="padding: 20px; text-align: center; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; color: #6b7280;">
          <p style="margin: 0; font-size: 16px;">No new matching jobs found in this run.</p>
        </div>
      `;
    } else {
      scoredMatches.forEach((match) => {
        const scoreColor = match.fitScore >= 80 ? "#10b981" : match.fitScore >= 60 ? "#f59e0b" : "#ef4444";
        const scoreBg = match.fitScore >= 80 ? "#ecfdf5" : match.fitScore >= 60 ? "#fffbeb" : "#fef2f2";
        const fitLabel = match.compFitLabel.toUpperCase();
        
        htmlContent += `
          <div style="margin-bottom: 20px; padding: 20px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
              <div style="flex: 1; padding-right: 12px;">
                <h3 style="margin: 0 0 4px 0; font-size: 18px; color: #111827; font-weight: 600;">${match.posting.title}</h3>
                <div style="font-size: 14px; color: #4b5563; font-weight: 500;">
                  ${match.posting.company} &bull; ${match.posting.location}
                </div>
              </div>
              <div style="background: ${scoreBg}; color: ${scoreColor}; padding: 6px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; text-align: center; min-width: 60px;">
                ${match.fitScore}% Fit
              </div>
            </div>
            <div style="margin-bottom: 12px; font-size: 13px;">
              <span style="background: #f3f4f6; color: #374151; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase;">
                Comp Fit: ${fitLabel}
              </span>
            </div>
            <p style="margin: 0 0 16px 0; font-size: 14px; color: #4b5563;">${match.reasoningText}</p>
            <a href="${match.posting.applyUrl}" target="_blank" style="display: inline-block; background: #7c3aed; color: #ffffff; padding: 8px 16px; border-radius: 4px; text-decoration: none; font-weight: 600; font-size: 14px; transition: background 0.2s;">
              Apply on ${match.posting.source}
            </a>
          </div>
        `;
      });
    }

    htmlContent += `
          <div style="margin-top: 24px; border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #9ca3af; text-align: center;">
            <p style="margin: 0 0 4px 0;">This digest was compiled and sent to you automatically.</p>
            <p style="margin: 0;">Timezone: Asia/Kolkata (IST). Run frequency: Daily at 9:00 AM and 9:00 PM.</p>
          </div>
        </div>
      </div>
    `;

    // Send email via Resend
    if (process.env.RESEND_API_KEY) {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Job Matcher <onboarding@resend.dev>",
          to: ["rishabh.raj.2002.rr@gmail.com"],
          subject: `Job Match Digest: ${scoredMatches.length} Matches Found`,
          html: htmlContent
        })
      });

      if (!emailRes.ok) {
        const errText = await emailRes.text();
        console.error("[cron] Failed to send email via Resend API:", errText);
        logs.push(`[email_error] ${errText}`);
      } else {
        console.log("[cron] Digest email sent successfully via Resend API.");
        logs.push("[email] Sent successfully to rishabh.raj.2002.rr@gmail.com");
      }
    } else {
      console.log("[cron] RESEND_API_KEY env is not configured, skipped email dispatch.");
      logs.push("[email_skipped] RESEND_API_KEY not configured");
    }

    res.json({ success: true, count: scoredMatches.length, logs });
  } catch (error) {
    console.error("[cron] Cron execution failure:", error);
    res.status(500).json({ error: (error as Error).message });
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
