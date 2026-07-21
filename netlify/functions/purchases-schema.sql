-- Run this once in the Supabase SQL editor to create the purchases table.
-- Written ONLY by the purchase-verify.js Netlify function using the SERVICE
-- key, so Row-Level Security is enabled with no policies, which locks the
-- table to the service role and blocks all anon/public access.

create table if not exists purchases (
  id           text primary key,   -- Stripe checkout session id (cs_…)
  username     text,               -- buyer's in-game username, if signed in
  amount_total integer,            -- in minor units (øre/cents), from Stripe
  currency     text,
  livemode     boolean,            -- false for test-mode purchases
  created_at   timestamptz not null default now()
);

create index if not exists purchases_created_idx on purchases (created_at desc);

-- Lock the table down: enabled RLS + no policies = service key only.
alter table purchases enable row level security;
