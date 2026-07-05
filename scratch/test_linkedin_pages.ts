import * as cheerio from "cheerio";

async function fetchSearchPage(keywords: string, location: string, start: number): Promise<string> {
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&start=${start}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) {
      console.log(`HTTP error page start=${start}: status=${res.status}`);
      return "";
    }
    return await res.text();
  } catch (err) {
    console.log(`Fetch error page start=${start}:`, err);
    return "";
  }
}

async function run() {
  let start = 0;
  let totalCards = 0;
  while (true) {
    const html = await fetchSearchPage("Product Manager", "Bengaluru, India", start);
    if (!html) break;
    const $ = cheerio.load(html);
    const cards = $("li > div.job-search-card, div.job-search-card");
    console.log(`Page start=${start}: found ${cards.length} cards`);
    if (cards.length === 0) break;
    totalCards += cards.length;
    start += cards.length;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`Total LinkedIn guest search cards found: ${totalCards}`);
}

run();
