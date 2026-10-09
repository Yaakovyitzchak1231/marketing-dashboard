-- 0015: comments pinned to a spot on a dashboard page ("comment on this").
--
-- Yaakov clicks any element on any page, writes a note for an agent (Tab by default), and sends it
-- now or later. Nothing he writes is lost: a draft is a row here from the first keystroke (the
-- browser also keeps a copy), so switching pages, refreshing or closing the tab keeps it.
--
--   lp.page_comments          one pin: where it is (page + element selector + fallback position + a
--                             text snapshot of what the element said), who it is for, the note, its tag,
--                             and its life: draft -> sent -> seen -> replied -> resolved.
--   lp.page_comment_replies   the thread on a pin (agent replies and Yaakov's follow-ups).
--
-- Sending writes an ordinary lp.notifications row (kind 'message'), so it goes out on the recipient's
-- delivery channels from migration 0013 like any other message. Additive only: no existing table
-- changes, nothing is backfilled. Safe to re-run.

create table if not exists lp.page_comments (
  id               bigint generated always as identity primary key,
  client_id        text not null unique check (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),  -- made by the browser, so a draft saved twice is one row
  author           text not null references lp.actors(id),
  recipient        text not null references lp.actors(id),
  page_path        text not null check (length(page_path) between 1 and 2000),  -- '/leads?tier=a'
  page_title       text check (length(page_title) <= 300),
  selector         text check (length(selector) <= 1000),        -- CSS selector of the element he pointed at
  anchor_label     text check (length(anchor_label) <= 200),     -- 'button "Send"', 'table cell', ...
  anchor_text      text check (length(anchor_text) <= 600),      -- what that element said when he pointed at it
  off_x            real check (off_x between 0 and 1),           -- where inside the element (fractions)
  off_y            real check (off_y between 0 and 1),
  x_pct            real check (x_pct between 0 and 1),           -- fallback when the element is gone: spot on the page
  y_pct            real check (y_pct between 0 and 1),
  body             text not null default '' check (length(body) <= 20000),
  tag              text check (tag in ('fix', 'question', 'idea')),
  notification_id  bigint references lp.notifications(id) on delete set null,
  sent_at          timestamptz,
  seen_at          timestamptz,                                  -- the recipient opened it through the API
  resolved_at      timestamptz,
  resolved_by      text references lp.actors(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists page_comments_author_idx on lp.page_comments (author, updated_at desc);
create index if not exists page_comments_recipient_idx on lp.page_comments (recipient, sent_at desc) where sent_at is not null;

drop trigger if exists page_comments_updated on lp.page_comments;
create trigger page_comments_updated before update on lp.page_comments for each row execute function lp.touch_updated_at();

create table if not exists lp.page_comment_replies (
  id               bigint generated always as identity primary key,
  page_comment_id  bigint not null references lp.page_comments(id) on delete cascade,
  author           text not null references lp.actors(id),
  body             text not null check (length(body) between 1 and 20000),
  notification_id  bigint references lp.notifications(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists page_comment_replies_thread_idx on lp.page_comment_replies (page_comment_id, created_at);
