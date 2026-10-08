# The lead engine (Find leads)

Tab's own lead-finding method, the one that built the October 2026 jeweler
lists, as a runnable engine inside this repo. You start a job on the **Find
leads** screen (`/find`); a runner (Tab by default) picks it up, works through
it, and the results land in **Leads** with the page each fact came from.

## What a job does

1. **Find businesses** (`discover`). Google Maps search results for each search
   phrase in each city (the top-1000 US cities; bigger cities get 2-3 pages).
   The default jeweler phrases are the measured set: 7 phrases x 1,000 cities
   = 7,609 searches, 0 blocks at 6 at a time, about 17 minutes, 30,854 unique
   places (Oct 6, 2026).
2. **Filter.** Drops chains (Kay, Zales, Jared ... by name and website), pawn
   shops and gold buyers, non-jewelers (by Maps category), businesses with no
   website or only a Facebook/Yelp/site-builder page, websites shared by 6+
   locations, and anything already in Leads (same website or phone). Every
   drop is counted with its reason on the job card.
3. **Read their websites** (`crawl`). Homepage plus up to 3 contact/about/team
   pages, respecting robots.txt, one request at a time per store with a pause
   between them. Reads emails (mailto links, plain text, Cloudflare-protected,
   "name [at] store [dot] com", JSON-LD), owner lines ("founded by ...",
   "Meet the owner ..."), phone, and Shopify/Square/Clover/Stripe/financing
   hints and "card surcharge" wording. Placeholder addresses from "email
   format" pages (first.last@, jsmith@) are thrown away.
4. **Owner search** (`owner`, optional). One web search per store for its
   owner, and one for `"@store.com"` when the site gave no email (this is how
   the Shopify stores that rate-limited us were rescued on Oct 6). Names tied
   to a different business in the snippet are dropped. Needs a search provider
   on the runner: `SEARXNG_URL` (free, self-hosted) or `SERPER_API_KEY` (paid).
   With neither, the step is skipped and the job card says so.
5. **Add to Leads** (`build`). One company per store (deduped on website,
   phone, name+address), contacts for each email, enrichment rows (owner,
   tech, MX) and a source row `find_leads:<job id>`. Nothing a person typed is
   overwritten.

Every search and every business is a checkpoint row (`lp.engine_items`), so a
job that crashes, is restarted, or is handed to another runner continues where
it stopped. Cancel stops it at the next business and keeps what it found.

## Running the runner

Jobs run for minutes to hours, so they run on a server (the OVH VPS), never in
a Vercel function. Node 22, no build step:

```
DATABASE_URL=postgres://... npm run engine -- worker --agent tab        # work jobs forever
DATABASE_URL=postgres://... npm run engine -- worker --agent tab --once
DATABASE_URL=postgres://... npm run engine -- run --states MD --max 10   # one-off job from the shell
DATABASE_URL=postgres://... npm run engine -- run --file stores.csv --max 200   # use a list instead of Maps
DATABASE_URL=postgres://... npm run engine -- status 12
```

Any agent can be the runner (`--agent hermes`). Without `DATABASE_URL`, a
runner with `OPS_URL` + `OPS_TOKEN` can still do single-company research over
the ops API; Find-leads jobs need the database for their checkpoints.

| Env var | What it does |
|---|---|
| `DATABASE_URL` | The lead database (required for Find leads). |
| `ENGINE_PROXIES` | Comma-separated proxy URLs (`http://user:pass@host:port`). Used only when a job ticks "Rotate proxies"; a proxy that fails 3 times in a row rests 5 minutes. Empty = direct. |
| `SEARXNG_URL` | Free self-hosted search for the owner step. |
| `SERPER_API_KEY` | Paid search alternative for the owner step. |
| `OPS_URL`, `OPS_TOKEN` | Ops-API door for research-only runners. |

## One company at a time

"Research this company" on Leads calls `POST /api/research/enqueue
{company_ids}`; each becomes a `research_company` task (Tab by default) that
reads the store's website the same way and writes through the same rules
(`lib/research/apply.ts`). Any agent that does its own research can hand back
the same `ResearchResult` shape (`lib/research/types.ts`).

## Honest limits

- Reading Google Maps results directly is against Google's terms of service.
  It is what found the October lists. The alternative is a file source: an
  Overture Maps / OpenStreetMap export or any CSV with name, website, phone,
  city, state.
- Owner names are thin from websites alone (Oct 6: about 1 in 10 stores);
  the owner search step roughly doubled that when it was on.
- The Shopify-hosted stores (one shared IP range) rate-limit fast crawling;
  the engine backs off a store that answers 429 for 15 minutes and falls back
  to search.
- Not ported yet: the Facebook page pass, Maps-review owner names, and SMTP
  mailbox checks (port 25 probing hurts the server's IP reputation; Outlook
  and GoDaddy refused about a quarter of probes on Oct 6). Verification lives
  on its own screen.
