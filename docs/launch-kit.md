# JobMatcher launch kit (TASK-089)

Draft copy for Product Hunt, Hacker News and Reddit. Nothing here has been posted.
Everything below describes what the product does today; replace the `[PLACEHOLDERS]`
before posting, and do not add usage numbers we cannot back up.

## Before launch day

- [ ] Custom domain (a `*.vercel.app` URL reads as a side project on PH/HN). Update Clerk's allowed origins and the referral links will follow automatically.
- [ ] Clerk in production mode (the app currently uses a `pk_test_` key and the Clerk dev sign-in page).
- [ ] Resend or Gmail sending limits checked against expected sign-ups (Gmail: ~500 recipients/day).
- [ ] Scoring capacity: free LLM tiers handle a handful of active users comfortably; a launch spike needs a paid fallback or a per-user daily cap (see "Capacity" below).
- [ ] `/api/health/cron` monitor and the cron-job.org keep-alive running (TASK-086).
- [ ] A test account with a CV so screenshots show real-looking data without anyone's personal CV.
- [ ] Each subreddit's self-promotion rules re-read the day you post (they change).

## Positioning

**One line:** JobMatcher reads your CV, checks five job sources for you every day, and emails you only the roles that actually fit, with a score and a reason for each.

**Who it is for:** people actively job hunting who are tired of scrolling LinkedIn and job boards, starting with product managers in India (the target role and city are configurable).

**What it does (facts we can stand behind):**
- Sources: LinkedIn (public listings), Naukri, and company boards on Greenhouse, Lever and Ashby.
- Each job gets a 0-100 fit score against your CV, a plain-English "why it fits", and a pay label (upgrade / lateral / downgrade) when it can be estimated.
- Early-career guard: senior titles are capped when your experience is short, so "Senior PM" roles stop topping the list.
- A daily email digest at the hour you choose, plus a web feed with To review / Saved / Applied tabs.
- Free. Your CV is used only to score jobs for you; contact details are never shown.

## Product Hunt

**Name:** JobMatcher

**Tagline (60 chars max):** Your CV, matched against new jobs every day (43 chars)
Alternatives:
- Stop scrolling job boards. Get the jobs that fit. (49)
- Daily job matches scored against your CV (40)

**Topics/tags:** Productivity, Hiring, Artificial Intelligence, Career (PH allows up to 3-4; pick by what is trending that week).

**Description (260 chars max):**
> JobMatcher reads your CV and checks LinkedIn, Naukri and company career pages every day. Each new role gets a fit score and a reason, and you get one email with only the jobs worth your time. Free.

**Maker's first comment:**
> Hi Product Hunt, I'm [NAME], a [ROLE] in [CITY].
>
> I built JobMatcher because my own job hunt was mostly scrolling: the same listings on five sites, half of them senior roles I wasn't eligible for, and no way to tell which ones were worth applying to.
>
> How it works:
> 1. Upload your CV (PDF, DOCX or paste text) and set the role you want.
> 2. Every day it pulls new postings from LinkedIn, Naukri and Greenhouse / Lever / Ashby boards.
> 3. An AI model scores each one against your CV (0-100) and writes one line on why it fits. Senior titles are capped if you're early in your career.
> 4. You get one email at the hour you pick, and a feed where you can save, mark applied, or dismiss.
>
> What I'd love feedback on: are the scores and the "why it fits" lines useful, and which job sources are we missing for your field?
>
> It's free. If it helps, Settings has an invite link to share it with friends who are looking too.

**Gallery / screenshot specs (1270 x 760 PNG, light and dark if possible):**
1. Matches feed: greeting, "N new matches since your last digest", two or three cards with high scores, the "Why it fits" line and an Upgrade chip visible. Use the test account.
2. One match card close-up: score badge, reason, pay label, Save / Apply buttons.
3. The daily email digest as it lands in Gmail (crop out the recipient address).
4. Onboarding step 2 ("Check what we found"): role, title, skills pulled from the CV.
5. Settings: digest time and "Where to look" (locations, sources).
Thumbnail (240 x 240): the logo mark on the brand blue.

## Hacker News: Show HN

**Title (80 chars max):** Show HN: JobMatcher - daily job matches scored against your CV, on free LLMs (76 chars)

**Post text:**
> I built JobMatcher to stop doing my job search by scrolling. It reads your CV, pulls new postings every day from LinkedIn's public listings, Naukri, and Greenhouse / Lever / Ashby company boards, scores each one against the CV with an LLM, and emails you the ones worth reading.
>
> Link: [URL]
>
> A few things that turned out to be more interesting than expected:
>
> **Running on free LLM tiers.** Scoring runs through a fallback chain: Groq's GPT-OSS 20B, then 120B, then Mistral's Ministral 14B/8B, then Gemini, then OpenRouter's free models. Each model has its own circuit breaker that trips on 429s and honours retry-after. The binding limit was never requests per day; it was Groq's tokens-per-minute (6-12K) against ~6K-token batches. We checked the fallbacks against stored scores on real postings: Ministral 14B made the same good/not-good call on 12/12, and a free Nemotron model agreed most closely but took 100-255s per batch, so it sits last.
>
> **Most of the "AI budget" problem was a selection bug.** Each day ~147 postings matched the target role, but ~119 of them had already been scored; the scheduler kept re-scoring them because Greenhouse's "posted" date is really an updated-at. Skipping anything scored since the CV last changed left ~28 genuinely new postings a day, which fit the free tier easily.
>
> **Embeddings didn't help.** I expected a local embedding model (bge-small, ONNX on the CI runner) to pre-rank postings before the LLM. On 731 scored postings its ranking was no better than random (Spearman 0.04-0.16 vs the LLM score): every candidate already says "Product Manager", and what separates them is seniority and fit, which the embedding doesn't see. It would also have added ~470 MB of runtime, so it isn't in the product.
>
> **Deterministic guards on top of the model.** Models sometimes ignore "cap senior roles at 20 for someone with 2 years' experience", so the cap is enforced in code after scoring. Untrusted posting text goes into the prompt inside a per-run random delimiter with brackets stripped, so a job description can't close the block and inject instructions.
>
> **Boring infrastructure that needed fixing.** GitHub's scheduled workflows only started 3-7 of 24 hourly runs a day, so an external scheduler triggers `workflow_dispatch`, a heartbeat endpoint alerts when runs stop, and a daily call keeps GitHub from auto-disabling the schedule. Moving the Vercel functions from the default US region to Mumbai (next to the Turso database) took API calls from ~290-560 ms to ~110-170 ms.
>
> Stack: TypeScript/Express on Vercel, Turso (libSQL), Clerk auth, GitHub Actions for the daily pipeline, vanilla JS front end.
>
> I'd especially like feedback on scoring quality and which sources to add. Happy to answer questions about the free-tier setup.

**Prepared answers for likely comments:**
- *"Is scraping LinkedIn allowed?"* - It uses LinkedIn's public, logged-out job listing pages only; no accounts, no logins, no private data.
- *"What happens to my CV?"* - Stored to score jobs for you; never shown to others; contact details are redacted in the UI. [Add the deletion path once account deletion ships.]
- *"Why not just use LinkedIn alerts?"* - Alerts match keywords; this reads the description against your CV, explains the score, and combines five sources.

## Reddit

General rules for all three: read the sidebar first, post from an account with history in that community, lead with the problem rather than the product, link once, and reply to every comment. Some subs only allow tools in a weekly thread; use that if so.

### r/ProductManagement

**Title:** I got tired of scrolling five job boards for APM/PM roles, so I built something that scores them against my CV

**Body:**
> I'm a [ROLE] looking for PM roles in [CITY]. Most of my search time went to scrolling the same listings on LinkedIn, Naukri and company career pages, and filtering out senior roles I wasn't eligible for.
>
> So I built a small tool: you upload your CV, it pulls new postings every day, scores each one 0-100 against your CV with a one-line reason, caps senior titles if you're early-career, and emails you once a day.
>
> It's free: [URL]
>
> Genuinely looking for feedback from PMs: does a fit score plus a reason actually help you decide what to apply to, or would you want something else (comp, team size, product area)?

### r/developersIndia

**Title:** Built a job matcher that runs entirely on free LLM tiers - here's what broke and what I learned

**Body:**
> Side project write-up. JobMatcher pulls jobs daily from LinkedIn public listings, Naukri, and Greenhouse / Lever / Ashby boards, scores each against your CV with an LLM, and emails a digest. It runs on free tiers only.
>
> Things that bit me:
> - Groq's tokens-per-minute limit, not requests per day, was the real ceiling.
> - I was re-scoring ~80% of postings every day because Greenhouse's "posted" date is really "updated".
> - A local embedding pre-ranker (bge-small) was no better than random for this, so I dropped it.
> - Vercel's default region is US East; moving functions to Mumbai next to the database cut API latency 3-4x.
> - GitHub Actions cron skipped most hourly runs; now an external scheduler triggers it, with a heartbeat alert.
>
> Stack: TypeScript, Express on Vercel, Turso, Clerk, GitHub Actions.
>
> Try it (free): [URL]. Happy to go deeper on any of these.

### r/cscareerquestions

Check the rules first: this sub generally removes self-promotion outside designated threads. If tools are only allowed in a weekly or daily thread, post there with this shorter version:

> I built a free tool for my own job search: it reads your CV, pulls new postings daily (LinkedIn public listings, Naukri, Greenhouse / Lever / Ashby boards), scores each 0-100 with a one-line reason, and emails you only the good ones. Senior roles are capped if you're early-career. Feedback welcome, especially on which sources to add: [URL]

## Capacity on launch day

The pipeline is sized for a few active users on free LLM tiers (each user's daily run scores up to 30 new postings in batches of 6). If sign-ups jump:
- New users' first run happens after their digest hour; use the "Manual digest for one user" workflow for anyone who reports an empty feed.
- Watch `/api/health/cron` and the Actions run times; if runs start taking long or fallbacks dominate, add a paid fallback (OpenRouter credit) or lower the per-run cap.

## Referral loop

Settings has an "Invite friends" card with a personal link (`/join?ref=<random code>`). Sign-ups through it are counted (accounts created within 7 days, once each, never self-referrals). There is no reward yet; that will be decided later.
