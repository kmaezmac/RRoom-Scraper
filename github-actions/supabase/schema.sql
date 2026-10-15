-- Execute once in the Supabase SQL editor. No credentials belong in this file.
create table if not exists public.room_post_history (
  account text not null check (account in ('account1', 'account2', 'account3')),
  item_code text not null,
  status text not null check (status in ('pending', 'posted', 'duplicate')),
  genre_id text not null default '',
  updated_at timestamptz not null default now(),
  primary key (account, item_code)
);
create table if not exists public.room_candidate_state (
  account text primary key check (account in ('account1', 'account2', 'account3')),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.room_post_history enable row level security;
alter table public.room_candidate_state enable row level security;
revoke all on public.room_post_history, public.room_candidate_state from anon, authenticated;
grant select, insert, update, delete on public.room_post_history, public.room_candidate_state to service_role;
-- No public policies: only server-side secret/service_role keys may access these tables.
