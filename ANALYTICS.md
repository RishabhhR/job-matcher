# JobMatcher browser analytics

The legacy `/` app and current `/v2/` app use `public/analytics.js`. It loads the
PostHog browser SDK only when `/api/analytics-config` returns a configured public
`POSTHOG_PROJECT_TOKEN`. `POSTHOG_HOST` defaults to the US ingest host. The same
project receives the privacy-filtered server events from `src/telemetry.ts`.

| Event | When | Main properties |
| --- | --- | --- |
| `$pageview` and `page_load` | A sign-in or app route is displayed | `page_name`, `surface`, `environment` |
| `$pageleave` and `page_leave` | Route change or page exit | `page_name`, `duration_ms`, `active_duration_ms` |
| `cta_click` | Any button, link, role button, or legacy shortcut is clicked | `page_name`, stable `control_id`, `control_type` |
| `section_viewed` | A named section enters the viewport | `page_name`, `section_name` |
| `$autocapture` | Browser SDK click capture for click maps | Masked element text and attributes |

`$pageview`/`$pageleave` power PostHog Web Analytics visitor, session-duration,
bounce and scroll reports. `page_leave.active_duration_ms` counts time while the
tab is visible. A browser without JavaScript, or with tracking blocked, is not
counted. Anonymous browser IDs can represent the same person on multiple devices.

The PostHog project has heatmap capture enabled. The SDK captures click maps and
scroll data; on PostHog's free plan, configure up to three allowed URL patterns
in **Project settings → Heatmaps → Heatmap capture URLs**. Recommended current
pages: `https://job-matcher-ecru.vercel.app/v2/#/matches`,
`https://job-matcher-ecru.vercel.app/v2/#/profile`, and
`https://job-matcher-ecru.vercel.app/v2/#/settings`. The `/#/` fragment is a
client route, so check PostHog's recorded URL format before adding patterns.

No CV text, profile field values, email address, job title, job URL, or match ID
is sent as a custom event property. Autocapture masks text and element
attributes, input changes are excluded, session replay is disabled, and the
PostHog project drops IP addresses. Control identifiers come from static IDs,
fixed action names, or app-authored class names.
