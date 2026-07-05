# Shared Implementation Plan: Clerk Auth, User-Specific Crons, and Real-Time Dashboard

This is the approved plan for implementing Clerk Authentication, User-Specific Cron Scheduling, and Real-Time Dashboard suggestions.

---

## 🔒 Configuration Specs

### 1. Clerk Authentication
- **Clerk Publishable Key**: `pk_test_c2tpbGxlZC1vcmNhLTc4LmNsZXJrLmFjY291bnRzLmRldiQ`
- **Clerk Frontend SDK JS URL**: `https://skilled-orca-78.clerk.accounts.dev/npm/@clerk/clerk-js@4/dist/clerk.browser.js`
- **Layout Flow**:
  - Show a fullscreen or centered translucent `#auth-container` if the user is not authenticated.
  - Show the main dashboard `#app-container` once Clerk is successfully loaded and authenticated.
  - Integrate a user button or custom Logout button in the header.

### 2. User DB Schema Migrations (`src/db.ts`)
- Alter `jm_users` table to add two columns:
  - `clerk_id TEXT UNIQUE` (to match Clerk's authenticated user ID).
  - `digest_hour INTEGER NOT NULL DEFAULT 9` (to store their preferred hourly cron time, 0-23).
- Update user registration to match by `clerk_id` or `email`.

### 3. Hourly Cron on GitHub Actions
- A new GitHub Actions workflow file `.github/workflows/cron-hourly.yml` configured to trigger every hour (`0 * * * *`).
- This executes a standalone script `npm run cron-hourly` (`src/cron.ts`) that runs sequentially on GitHub runner without hitting Vercel's 60-second limit.
- **`src/cron.ts` Logic**:
  - Checks the current hour.
  - Queries active users (`digest_enabled = 1`).
  - Converts current time to the user's local timezone (e.g. `user.timezone` defaults to `Asia/Kolkata`).
  - If `localHour === user.digest_hour`, triggers the scrape + scoring + Resend email digest pipeline.

### 4. Frontend & Backend Form Integration
- Add a checkbox to toggle `digest_enabled` and a select dropdown for `digest_hour` in the Scraping Configuration segment of the UI.
- Prefill user details, CV text, and settings dynamically on login via a new `/api/user/init` endpoint.
