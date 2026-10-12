-- 0064: journey templates (recipes) -- plan 3.16.
--
--   lp.journey_recipes  pre-built journey recipes selectable at journey
--                      (campaign) creation: a name, the goal the recipe
--                      serves, and the step definitions to instantiate.
--                      Seeded below; user-saved campaign copies (the existing
--                      is_template flow) are separate and untouched.
--
-- Add-only: no existing object is touched.

create table if not exists lp.journey_recipes (
  id          bigint generated always as identity primary key,
  key         text not null unique check (key ~ '^[a-z0-9_]{1,40}$'),
  name        text not null check (length(name) between 1 and 120),
  description text not null check (length(description) between 1 and 500),
  goal_key    text not null check (length(goal_key) between 1 and 40),
  steps       jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

insert into lp.journey_recipes (key, name, description, goal_key, steps, sort) values
('cold_outreach_3step', 'Cold outreach (3 steps)',
 'First touch, a short bump, then a graceful breakup. For new prospect lists.',
 'book_meetings',
 '[{"step_number":1,"variant":"A","subject":"Quick question, {{first_name}}","body":"Hi {{first_name}},\n\nI work with {{company}}''s peers on {{topic}}. Worth a 15-minute look next week?\n\n{{sender_name}}","delay_days":0},{"step_number":2,"variant":"A","subject":"Re: Quick question, {{first_name}}","body":"Hi {{first_name}},\n\nFloating this back up in case it got buried. Still open to a brief chat?\n\n{{sender_name}}","delay_days":3},{"step_number":3,"variant":"A","subject":"Should I close this out?","body":"Hi {{first_name}},\n\nI will take the silence as a no for now and close this out. If {{topic}} becomes a priority, just reply and I will pick it right back up.\n\n{{sender_name}}","delay_days":7}]'::jsonb,
 10),
('reengagement_2step', 'Re-engagement (2 steps)',
 'Win back leads that went quiet. Short, human, one clear ask.',
 'reengage',
 '[{"step_number":1,"variant":"A","subject":"Still thinking about {{topic}}?","body":"Hi {{first_name}},\n\nIt has been a while since we talked about {{topic}}. A lot has changed on our end. Open to a fresh 10 minutes?\n\n{{sender_name}}","delay_days":0},{"step_number":2,"variant":"A","subject":"Last note from me","body":"Hi {{first_name}},\n\nI do not want to keep emailing if the timing is off. Reply with a thumbs up or down and I will act accordingly.\n\n{{sender_name}}","delay_days":5}]'::jsonb,
 20),
('post_meeting_followup', 'Post-meeting follow-up (2 steps)',
 'Strike while the conversation is warm: recap, then useful material.',
 'nurture',
 '[{"step_number":1,"variant":"A","subject":"Great speaking today","body":"Hi {{first_name}},\n\nThanks for the time today. As promised, here is the recap of what we covered on {{topic}}.\n\n{{sender_name}}","delay_days":0},{"step_number":2,"variant":"A","subject":"Something useful on {{topic}}","body":"Hi {{first_name}},\n\nThought you would find this useful given our chat. Happy to walk through it whenever suits.\n\n{{sender_name}}","delay_days":2}]'::jsonb,
 30),
('breakup_last_touch', 'Breakup / last touch (1 step)',
 'One honest last email to close the loop or revive the thread.',
 'get_replies',
 '[{"step_number":1,"variant":"A","subject":"Permission to close the loop?","body":"Hi {{first_name}},\n\nI have reached out a few times about {{topic}} without hearing back. May I close the loop on my end?\n\n{{sender_name}}","delay_days":0}]'::jsonb,
 40)
on conflict (key) do nothing;
