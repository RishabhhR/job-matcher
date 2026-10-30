import * as dotenv from "dotenv";
dotenv.config();
import { client } from "../src/db.js";

async function check() {
  try {
    const totals = await client.execute("SELECT visit_date, COUNT(DISTINCT visitor_hash) as visitors, SUM(hits) as total_hits FROM jm_daily_visitors GROUP BY visit_date ORDER BY visit_date DESC");
    console.log("Daily totals:\n", JSON.stringify(totals.rows, null, 2));

    const paths = await client.execute("SELECT path, SUM(hits) as hits, COUNT(DISTINCT visitor_hash) as visitors FROM jm_daily_visitors GROUP BY path ORDER BY hits DESC LIMIT 15");
    console.log("Top paths:\n", JSON.stringify(paths.rows, null, 2));

    const referrers = await client.execute("SELECT referrer, SUM(hits) as hits, COUNT(DISTINCT visitor_hash) as visitors FROM jm_daily_visitors WHERE referrer IS NOT NULL GROUP BY referrer ORDER BY hits DESC LIMIT 15");
    console.log("Top referrers:\n", JSON.stringify(referrers.rows, null, 2));

    const jobCount = await client.execute("SELECT count(*) as cnt FROM jm_job_postings");
    console.log("Total job postings in DB:\n", JSON.stringify(jobCount.rows[0], null, 2));

    const userCount = await client.execute("SELECT count(*) as cnt FROM jm_users");
    console.log("Total users:\n", JSON.stringify(userCount.rows[0], null, 2));
  } catch (e) {
    console.error("Error querying db:", e);
  } finally {
    await client.close();
  }
}
check();
