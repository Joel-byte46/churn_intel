create table public.customers (
  id                        uuid default gen_random_uuid() primary key,
  user_id                   uuid references public.users not null,
  stripe_customer_id        text not null,
  email                     text,
  mrr                       decimal(10,2) default 0,
  plan_name                 text,
  tenure_days               int default 0,
  days_since_login          int default 0,
  feature_adoption_rate     decimal(4,3) default 0,
  plan_usage_pct            decimal(5,2) default 0,
  health_score              decimal(5,2) default 100,
  last_intervention_at      timestamptz,
  last_intervention_type    text,
  interventions_count       int default 0,
  invalid_email             boolean default false,
  updated_at                timestamptz default now(),

  unique(user_id, stripe_customer_id)
);

create index idx_customers_user_id      on public.customers(user_id);
create index idx_customers_health_score on public.customers(health_score);

alter table public.customers enable row level security;

create policy "Users see own customers"
  on public.customers for all
  using (auth.uid() = user_id);
