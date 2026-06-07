-- Run this once in the Supabase SQL editor to create the feedback table.
-- Feedback is written ONLY by the feedback.js Netlify function using the
-- SERVICE key, so Row-Level Security is enabled with no policies, which locks
-- the table to the service role and blocks all anon/public access.

create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  message     text not null,
  username    text,            -- optional: only set when the player is signed in
  lang        text,            -- UI language at time of submission
  screen      text,            -- screen the player was on
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- Newest-first browsing in the dashboard.
create index if not exists feedback_created_idx on feedback (created_at desc);

-- Lock the table down: enabled RLS + no policies = service key only.
alter table feedback enable row level security;
