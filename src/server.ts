import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { runJobMatcher } from "./runner.js";
import { runDigest } from "./digest.js";
import {
  upsertUser,
  upsertUserProfile,
  upsertCv,
  deletePendingMatches,
  bulkInsertPostingsAndPendingMatches,
  getPaginatedMatchesForUser,
  getTotalMatchCountForUser,
  updateMatchScore,
  getActiveCvText,
  getUserProfileRow
} from "./db.js";
import { fetchAllPostings } from "./scrapers.js";
import { fetchLinkedInPublic, fetchLinkedInDescriptions } from "./scrapers/linkedin.js";
import { dedupePostings } from "./normalize.js";
import { keywordPrefilter, scoreAll } from "./match.js";

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
      const pdfreaderModule = await import("pdfreader");
      const PdfReader = pdfreaderModule.PdfReader || (pdfreaderModule as any).default?.PdfReader;
      if (!PdfReader) {
        throw new Error("Failed to load PdfReader from pdfreader module.");
      }

      text = await new Promise<string>((resolve, reject) => {
        let content = "";
        const reader = new PdfReader();
        reader.parseBuffer(buffer, (err: any, item: any) => {
          if (err) {
            reject(err);
          } else if (!item) {
            resolve(content);
          } else if (item.text) {
            content += item.text + " ";
          }
        });
      });
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
  const isTest = req.query.secret === "test";
  if (process.env.VERCEL && process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}` && !isTest) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (process.env.TURSO_DATABASE_URL) {
      console.log("[cron] TURSO_DATABASE_URL is defined. Running database-backed runDigest workflow...");
      const slotParam = req.query.slot as "am" | "pm" | undefined;
      const modeParam = req.query.mode as "scrape" | "email" | "all" | undefined;
      const result = await runDigest({
        slot: slotParam,
        mode: modeParam
      });
      res.json({ success: true, database: true, ...result });
      return;
    }

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
        maxResults: 1000
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

// SSE endpoint to run the initial scraper and stream progress updates, returning the first page of matches
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
    const userEmail = "rishabh.raj.2002.rr@gmail.com";
    const userName = "Rishabh Raj";
    
    sendEvent("progress", { status: "system", message: "Connecting to database..." });
    const userId = await upsertUser(userEmail, userName);
    await upsertUserProfile(userId, profile);
    await upsertCv(userId, cvText);

    sendEvent("progress", { status: "scraping_ats", message: `Scraping ATS boards for companies: ${[...companies.greenhouse, ...companies.lever, ...companies.ashby].join(", ")}` });
    const atsPostingsRaw = await fetchAllPostings(companies);
    
    // Filter ATS by location
    const patterns = [/remote/i, /\bhybrid\b/i, /anywhere/i];
    if (profile.preferredCountry) patterns.push(new RegExp(profile.preferredCountry, "i"));
    if (profile.preferredCity) patterns.push(new RegExp(profile.preferredCity, "i"));
    
    const filterByLoc = (postings: any[]) => {
      if (!profile.preferredCountry && !profile.preferredCity) return postings;
      return postings.filter(p => {
        const loc = p.location || "";
        if (!loc) return true;
        return patterns.some(re => re.test(loc));
      });
    };

    const atsPostings = filterByLoc(atsPostingsRaw);
    sendEvent("progress", { status: "scraping_ats_complete", message: `Fetched ${atsPostingsRaw.length} ATS postings, ${atsPostings.length} matched location filter.` });

    const linkedinKeywords = profile.targetDesignation;
    const defaultLinkedinLocation = [profile.preferredCity, profile.preferredCountry].filter(Boolean).join(", ") || "worldwide";
    const linkedinLocation = linkedin?.location || defaultLinkedinLocation;
    // Clamped to 150: this handler still runs the LinkedIn search/scrape step
    // synchronously (only per-job scoring got paginated), and Vercel's function
    // has a 60s hard cap (vercel.json) - a 1000-result search alone can exceed
    // that just from its own pagination delays, before any scoring even starts.
    const linkedinMaxResults = Math.min(linkedin?.maxResults || 100, 150);

    sendEvent("progress", { status: "scraping_linkedin", message: `Scraping LinkedIn for "${linkedinKeywords}" in ${linkedinLocation} (max ${linkedinMaxResults} results)...` });
    const linkedinPostingsRaw = await fetchLinkedInPublic({
      keywords: linkedinKeywords,
      location: linkedinLocation,
      maxResults: linkedinMaxResults,
      fetchDescriptions: false,
    });
    
    const linkedinPostings = filterByLoc(linkedinPostingsRaw);
    sendEvent("progress", { status: "scraping_linkedin_complete", message: `Fetched ${linkedinPostingsRaw.length} LinkedIn postings, ${linkedinPostings.length} matched location filter.` });

    const rawPostings = [...atsPostings, ...linkedinPostings];
    sendEvent("progress", { status: "processing", message: `Total raw postings collected: ${rawPostings.length}. Running deduplication...` });
    const deduped = dedupePostings(rawPostings);
    sendEvent("progress", { status: "processing", message: `Deduplication complete. Retained ${deduped.length} unique postings.` });
    const shortlisted = keywordPrefilter(deduped, profile.targetDesignation);

    sendEvent("progress", { status: "processing", message: `Filtered down to ${shortlisted.length} matching target designation "${profile.targetDesignation}". Saving to database...` });
    
    // Clear old pending matches and save new ones
    await deletePendingMatches(userId);
    await bulkInsertPostingsAndPendingMatches(userId, shortlisted);

    const totalMatches = await getTotalMatchCountForUser(userId);
    sendEvent("progress", { status: "processing", message: `Saved ${totalMatches} matching postings to database. Preparing Page 1...` });

    // Fetch and score Page 1 immediately (first 10 jobs)
    const page1Jobs = await getPaginatedMatchesForUser(userId, 0, 10);
    const pendingPage1 = page1Jobs.filter((j: any) => j.status === "pending");

    if (pendingPage1.length > 0) {
      sendEvent("progress", { status: "scraping_linkedin_descriptions", message: `Fetching descriptions for ${pendingPage1.length} new jobs on Page 1...` });
      
      const postingsToFetch = pendingPage1.map((j: any) => ({
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        applyUrl: j.applyUrl,
        descriptionText: "",
      }));
      
      await fetchLinkedInDescriptions(postingsToFetch);

      sendEvent("progress", { status: "scoring", message: `Scoring ${pendingPage1.length} new jobs on Page 1 against CV via AI fallback chain...` });
      const { results: scoredResults } = await scoreAll(cvText, profile, postingsToFetch, postingsToFetch.length);

      for (let i = 0; i < pendingPage1.length; i++) {
        const job = pendingPage1[i];
        const scored = scoredResults[i];
        const description = postingsToFetch[i].descriptionText;
        await updateMatchScore(userId, job.posting_id, scored.fitScore, scored.compFitLabel, scored.reasoningText, description);
      }
    }

    // Query fully updated page 1 scored matches
    const finalPage1 = await getPaginatedMatchesForUser(userId, 0, 10);
    
    // Transform rows to ScoredMatch format
    const results = finalPage1.map((j: any) => ({
      posting: {
        id: j.posting_id,
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        descriptionText: j.descriptionText || "",
        applyUrl: j.applyUrl,
      },
      fitScore: j.fitScore,
      compFitLabel: j.compFitLabel,
      reasoningText: j.reasoningText,
    }));

    sendEvent("done", { userId, totalMatches, results });
  } catch (error) {
    console.error("Match error:", error);
    sendEvent("error", { message: (error as Error).message });
  } finally {
    res.end();
  }
});

// Fetch and score a specific page of matches (dynamic/lazy descriptions & scores)
app.post("/api/match/page", async (req, res) => {
  const { userId, page, limit = 10 } = req.body;

  if (!userId || !page) {
    res.status(400).json({ error: "Missing required fields (userId or page)" });
    return;
  }

  try {
    const cvText = await getActiveCvText(userId);
    const profile = await getUserProfileRow(userId);

    if (!cvText || !profile) {
      res.status(400).json({ error: "Active CV or profile not found for this user." });
      return;
    }

    const offset = (page - 1) * limit;
    const pageJobs = await getPaginatedMatchesForUser(userId, offset, limit);
    const pendingJobs = pageJobs.filter((j: any) => j.status === "pending");

    if (pendingJobs.length > 0) {
      const postingsToFetch = pendingJobs.map((j: any) => ({
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        applyUrl: j.applyUrl,
        descriptionText: "",
      }));
      
      await fetchLinkedInDescriptions(postingsToFetch);
      const { results: scoredResults } = await scoreAll(cvText, profile as any, postingsToFetch, postingsToFetch.length);

      for (let i = 0; i < pendingJobs.length; i++) {
        const job = pendingJobs[i];
        const scored = scoredResults[i];
        const description = postingsToFetch[i].descriptionText;
        await updateMatchScore(userId, job.posting_id, scored.fitScore, scored.compFitLabel, scored.reasoningText, description);
      }
    }

    // Re-query fully updated page scored matches
    const finalPageJobs = await getPaginatedMatchesForUser(userId, offset, limit);
    const results = finalPageJobs.map((j: any) => ({
      posting: {
        id: j.posting_id,
        source: j.source,
        sourceJobId: j.sourceJobId,
        company: j.company,
        title: j.title,
        location: j.location,
        descriptionText: j.descriptionText || "",
        applyUrl: j.applyUrl,
      },
      fitScore: j.fitScore,
      compFitLabel: j.compFitLabel,
      reasoningText: j.reasoningText,
    }));

    res.json({ success: true, results });
  } catch (error) {
    console.error("Match page error:", error);
    res.status(500).json({ error: (error as Error).message });
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
