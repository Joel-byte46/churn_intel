create table public.users (
  id                    uuid references auth.users primary key,
  email                 text not null,
  first_name            text,
  product_name          text,
  stripe_account_id     text,
  stripe_access_token   text,
  plan                  text default 'free',
  autopilot_active      boolean default false,
  anthropic_key_set     boolean default false,
  setup_completed       boolean default false,
  created_at            timestamptz default now()
);

alter table public.users enable row level security;

create policy "Users see own profile"
  on public.users for all
  using (auth.uid() = id);
