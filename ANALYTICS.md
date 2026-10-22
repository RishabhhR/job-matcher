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

The production domain is authorized for Web Analytics. Heatmap capture is enabled
in the PostHog project, with `https://job-matcher-ecru.vercel.app/*` saved as
the allowed URL pattern. PostHog currently accepts this rule and reports that
it covers all observed legacy and `/v2/` pages. Its free-plan notice says
capture will be limited to three pages from 15 November 2026; revisit the
rule before that change. PostHog recorded a click coordinate
on the authenticated Matches route after this rule was saved. Saved views are
available for [sign-in](https://us.posthog.com/project/679145/heatmaps/EVyNHy1b),
[Matches](https://us.posthog.com/project/679145/heatmaps/AMLQf4gy),
[Profile](https://us.posthog.com/project/679145/heatmaps/IGjyOUQh), and
[Settings](https://us.posthog.com/project/679145/heatmaps/37mU3esD).
PostHog's live iframe preview cannot load the authenticated app pages; click
coordinates and section-view events are still captured. Do not use a signed-out
screenshot as the background for authenticated-page heatmaps because its layout
would be misleading.

The [JobMatcher Product Analytics dashboard](https://us.posthog.com/project/679145/dashboard/2246568)
contains visitors, visits, average session duration, average active time per
page, top pages, CTA clicks, sections seen, and page loads. The Web Analytics
view also reports visitor and session metrics. Counts begin with the browser
analytics rollout on 22 October 2026, so earlier periods will be empty.

No CV text, profile field values, email address, job title, job URL, or match ID
is sent as a custom event property. Autocapture masks text and element
attributes, input changes are excluded, session replay is disabled, and the
PostHog project drops IP addresses. Control identifiers come from static IDs,
fixed action names, or app-authored class names.
