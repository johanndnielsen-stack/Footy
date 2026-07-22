-- Run this once in the Supabase SQL editor to create the trades table.
-- Trades are accessed ONLY by the trade.js Netlify function using the
-- SERVICE key, so Row-Level Security is enabled with no policies, which locks
-- the table to the service role and blocks all anon/public access.

create table if not exists trades (
  id            uuid primary key default gen_random_uuid(),
  from_username text not null,
  to_username   text not null,
  offer_card    jsonb not null,   -- snapshot of the proposer's card at propose time
  request_card  jsonb not null,   -- snapshot of the recipient's card at propose time
  -- pending: awaiting recipient decision
  -- declined / cancelled: no cards moved
  -- accepted: cards swapped server-side; proposer's device hasn't synced yet
  -- done: proposer has synced — fully settled
  -- failed: recipient accepted but a card had already moved (sold/re-traded)
  status        text not null default 'pending',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists trades_to_idx on trades (to_username, status);
create index if not exists trades_from_idx on trades (from_username, status);

alter table trades enable row level security;

-- Table-level grant for the service role. RLS-with-no-policies blocks
-- row access for everyone except service_role (which bypasses RLS), but
-- PostgREST still checks a plain GRANT before RLS even applies — accounts
-- got this automatically from the project's default privileges, but a table
-- created straight from the SQL editor doesn't always inherit that, which is
-- why "propose" was failing with 42501 "permission denied for table trades".
grant select, insert, update, delete on table trades to service_role;
