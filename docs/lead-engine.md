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
5. **Extra owner sources** (opt-in; off unless the job ticks them). They run
   between the owner search and Add to Leads, only where they can still add
   something (e.g. reviews and Yelp are skipped for a store whose own site
   already named the owner with high confidence). See the next section.
6. **Add to Leads** (`build`). One company per store (deduped on website,
   phone, name+address), contacts for each email, enrichment rows (owner,
   tech, MX) and a source row `find_leads:<job id>`. Nothing a person typed is
   overwritten.

## Extra owner sources (opt-in stages)

Owner first names and direct emails are what made the October lists work, and
the store websites alone name the owner for only about 1 in 10 stores. These
five stages are ported from Tab's Oct 6 enrichment (`tapdash_scraper/enrich.py`,
`enrich2.py`). Tick them on **Find leads**, or pass them to the CLI:
`npm run engine -- run --states MD --max 50 --stages discover,crawl,owner,reviews,yelp,firstlast,pattern,build`.

| Stage | What it reads | Confidence | Needs |
|---|---|---|---|
| `reviews` | Up to 40 Google Maps reviews of the store (by its Maps id) for lines like "Clint, the owner, ..." and owner replies ("Thanks! This is Ken the owner"). Mentions of a late, former or retired owner and of relatives ("the owner's son") are dropped; when someone is called the "new owner", only they count. Measured Oct 6: the best new name source, 506 names. | 2+ separate reviews naming the same person = high; one review = medium. A review name that matches a weaker name from the website raises it to high. | Serper (`SERPER_API_KEY`). SearXNG has no reviews endpoint, so with SearXNG the stage is skipped and the job card says so. |
| `yelp` | `site:yelp.com "<store>" <city> "Business Owner"`: "Ken P. Business Owner" reply lines, only from results whose Yelp listing title names this store. | medium | A search provider. |
| `firstlast` | `"<first>" "<store>" <city> owner` for a first-name-only owner: the word after the first name in snippets about this store (on its site, or naming it), with an owner/founder/jeweler word or on the store's own site. Names tied to another business are dropped. | The owner's name gains the last name; the last name is stored as its own fact (`owner_last_name`, medium) with the page it came from. | A search provider. |
| `facebook` | For stores whose website gave no email: `"<store>" <city> <ST> site:facebook.com`, the store's own page (title or page slug must match; profiles and posts skipped), then the page's logged-out HTML for an exposed email. One page every 4 s. | Email saved with `email_source = facebook`, the page as evidence. Not verified. | A search provider. Logged-out Facebook often shows a login wall instead of the page; walled pages are recorded and skipped, not retried. Oct 5's large pass used a real browser and found an email on 59% of pages read; a plain fetch will find fewer. |
| `pattern` | The store's own published person address (from its site or an `"@domain"` search), e.g. `sarah@` or `sarah.jones@`, applied to the owner's name: `ken@` / `ken.palmetto@`. Needs no network. Placeholders (`john.smith@`, `first.last@`) and role addresses (`info@`) teach nothing. | **A guess.** Saved as a contact with `status = 'guessed-hold'`, `email_source = 'guessed'`, an `email_guess` enrichment row at medium confidence, and the page the pattern was learned from as evidence. Never sendable until verification says so. If the published address is the owner's own (same first name), it is a found address, not a guess. | Nothing. |

Every row these stages write goes through `lib/research/apply.ts` like the
rest: no evidence page, no row; nothing a person typed is overwritten. The job
card counts stores checked, names found, Facebook emails and pattern guesses
(`extras_checked`, `extra_names`, `facebook_emails`, `pattern_guesses`), and the
activity feed gets one line when the stage finishes. Each search goes through
one shared lane (300 ms apart) and every call has a 45 s deadline; a store that
fails three times moves on without the extra evidence.

Terms of service, plainly: reading Google Maps reviews through a search API,
and Yelp and Facebook pages through search results or a logged-out fetch, are
uses those sites' terms do not grant (Yelp's and Meta's terms forbid automated
collection; Google's forbid scraping Maps content). It is what Tab did in
October. Keep volumes low, use the official APIs where they exist (Yelp Fusion
returns no owner names), and treat these stages as research, not a bulk feed.

Not ported: SMTP mailbox checks on guessed addresses (they hurt the server's
IP reputation; the verification screen's waterfall is the place for that),
LinkedIn and BBB passes, and Maps reviews pages 3-5 (measured 1 extra name in
25 stores for 3 extra calls each).

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
| `SEARXNG_URL` | Free self-hosted search for the owner step and the yelp / firstlast / facebook stages (no Maps reviews). |
| `SERPER_API_KEY` | Paid search alternative for the owner step; the only provider with Maps reviews (`reviews` stage). |
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
- Not ported yet: SMTP
  mailbox checks (port 25 probing hurts the server's IP reputation; Outlook
  and GoDaddy refused about a quarter of probes on Oct 6). Verification lives
  on its own screen.
