# SEO / AEO / GEO section (`/seo`)

Shows whether TapDash's sites can be found in Google **and** named in AI answers (ChatGPT, Claude, Gemini, Perplexity), and lets you fix what's wrong from the dashboard.

## Screens
- **Overview**: a scorecard per site (pass / fix / improve / couldn't check), AI-answer results per model, top fixes.
- **Sites**: the tracked sites (seeded: tapdash.co with /jewelers/, /jewelers/compare/, /digital/, /partners/; ai-builder-pay.lovable.app). Add, pause, run an audit.
- **Technical audit**: run on demand; every run is stored (history). Checks: bot wall in front of the site (SiteGround's anti-bot captcha), AI crawlers in robots.txt (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Google-Extended, Googlebot, Bingbot), llms.txt, sitemap (and test/leftover pages in it), per page: indexing allowed, title, description, generic wording, main heading (H1), canonical, FAQ schema, Offer/price schema, readable text; Organization schema; mobile speed (PageSpeed, with a free key). A check we couldn't measure says "Couldn't check", never a guess.
- **AI visibility**: the questions buyers ask (editable), competitors to watch for (editable), "Run check now" per model. Each answer records whether TapDash was named, which competitors were, and which sites were cited. A model runs only when its key is set.
- **Fix list**: every failing check becomes a task (`kind = seo_fix`, project "SEO / AI visibility") on the same board as everything else, so you, Tab or Hermes can claim it. Each fix has a button:
  - *Edit in WordPress* (title, description, canonical): edit, **Preview change** (live value from WordPress, shown as a diff), **Apply**, **Undo**.
  - *Add to WordPress* (FAQ / Service+Offer JSON-LD): same preview, apply, undo. JSON must parse and have no `EDIT:` placeholders left.
  - *Hide pages*: per test page, "Hide from Google" (Yoast noindex) or "Move to draft"; undoable.
  - *Create draft*: creates a WordPress **draft** page (buyer guide, comparison page). Never publishes. Undo trashes the draft.
  - *Copy & paste*: files for sites we can't write to (llms.txt for the Lovable site).
  - *Steps* + **Done, re-check** for things only you can do (SiteGround, Elementor headings, keys). The re-check re-runs the audit and closes fixes that now pass.
  - **Assign** (Tab, Hermes, Claude, Manus, you), **Mark done**, **Dismiss**, **Reopen**. Everything logs to Activity.
- **Search Console**: Google's own queries/pages (clicks, impressions, CTR, position) and Bing's, once connected.

## Env vars (all optional; each feature says what it needs when it's missing)
| Var | What | Cost |
|---|---|---|
| `WP_SITE_URL`, `WP_USER`, `WP_APP_PASSWORD` | WordPress REST API with an Application Password (Users > Profile > Application Passwords) | Free (built into WordPress) |
| `PAGESPEED_API_KEY` | Google PageSpeed Insights API key | Free |
| `GSC_CLIENT_EMAIL`, `GSC_PRIVATE_KEY`, `GSC_SITE_URL` | Search Console service account (add its email as a user on the property) | Free |
| `BING_WEBMASTER_API_KEY`, `BING_SITE_URL` | Bing Webmaster Tools API key | Free |
| `GEMINI_API_KEY` (+ `SEO_GEMINI_MODEL`) | AI visibility on Gemini | Free tier; grounded search needs a billing-enabled project (first 5,000 grounded requests/month free) |
| `OPENAI_API_KEY` (+ `SEO_OPENAI_MODEL`) | AI visibility on ChatGPT's models | Paid: cents/month; ~$1-2/month with web search |
| `ANTHROPIC_API_KEY` (+ `SEO_ANTHROPIC_MODEL`) | AI visibility on Claude | Paid: cents/month |
| `PERPLEXITY_API_KEY` (+ `SEO_PERPLEXITY_MODEL`) | AI visibility on Perplexity | Paid per request |
| `SEO_WEB_SEARCH=1` | Let models search the web live (closer to what people see; costs more on paid APIs) | — |

## WordPress: the one-time snippet
tapdash.co is built with Elementor, which ignores page text sent through the API, and Yoast keeps titles/descriptions/canonicals in hidden fields. The fix page shows a short PHP snippet (paste into the free Code Snippets plugin) that exposes exactly those Yoast fields plus a `_tapdash_jsonld` field it prints in `<head>`. Without it, "Move to draft" and "Create draft" still work; the Yoast and schema buttons explain what's needed.

**SiteGround note:** SiteGround's anti-bot system answers cloud servers with a captcha page. The dashboard's audits run from Vercel (a cloud server), so tapdash.co may audit as "Couldn't check" until SiteGround lets automated traffic through, and the WordPress API calls can hit the same wall (the error says so in plain words). That same wall is the top fix: AI crawlers come from cloud servers too.

## Database
`db/migrations/0004_seo.sql` (additive): `lp.seo_sites`, `lp.seo_audits`, `lp.seo_prompts`, `lp.seo_competitors`, `lp.seo_visibility_runs`, `lp.seo_visibility_results`, `lp.seo_changes` (before/after of every WordPress change), plus the "SEO / AI visibility" project and seed sites, questions and competitors. Apply with `npm run db:migrate`.

## For agents
Fixes are ordinary tasks: `claim_task` with `kinds: ["seo_fix"]`; the task payload carries `{site_id, fix: {title, detail, fix, action}}`. Report and complete through the ops API like any other task.
