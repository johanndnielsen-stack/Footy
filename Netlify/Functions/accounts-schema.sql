-- Run this once in the Supabase SQL editor to create the accounts table.
-- Accounts are accessed ONLY by the account.js Netlify function using the
-- SERVICE key, so Row-Level Security is enabled with no policies, which locks
-- the table to the service role and blocks all anon/public access.

create table if not exists accounts (
  id            uuid primary key default gen_random_uuid(),
  username      text not null,
  username_lower text not null unique,
  pin_hash      text not null,
  tokens        jsonb not null default '[]'::jsonb,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Fast token lookups for auto-login (jsonb containment).
create index if not exists accounts_tokens_idx on accounts using gin (tokens);

-- Lock the table down: enabled RLS + no policies = service key only.
alter table accounts enable row level security;
