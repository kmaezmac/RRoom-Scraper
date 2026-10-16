-- Apply before enabling the new social runner. No ROOM IDs/URLs are stored.
create table if not exists public.room_social_state (
  account text primary key check (account in ('account1','account2','account3')),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.room_social_state enable row level security;
revoke all on public.room_social_state from anon, authenticated;
grant select, insert, update on public.room_social_state to service_role;
-- Do not reset these timestamps when deleting posts: ROOM's action limits persist.
