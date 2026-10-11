-- Reply context travels as data, never inferred from prose.
alter table lp.notifications add column if not exists page_comment_id bigint references lp.page_comments(id) on delete set null;
alter table lp.notifications add column if not exists auto_reply boolean not null default false;
update lp.notifications n set page_comment_id = c.id
  from lp.page_comments c where c.notification_id = n.id and n.page_comment_id is null;
update lp.notifications n set page_comment_id = r.page_comment_id
  from lp.page_comment_replies r where r.notification_id = n.id and n.page_comment_id is null;
