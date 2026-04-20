create table public.churn_analyses (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references public.users not null,
  churned_customers     jsonb not null default '[]',
  active_customers      int not null default 0,
  total_mrr             decimal(10,2) not null default 0,
  pattern               jsonb,
  diagnosis             jsonb,
  low_confidence        boolean default false,
  status                text default 'pending',
  email_sent_at         timestamptz,
  created_at            timestamptz default now()
);

create index idx_churn_analyses_user_id on public.churn_analyses(user_id);
create index idx_churn_analyses_status  on public.churn_analyses(status);

alter table public.churn_analyses enable row level security;

create policy "Users see own analyses"
  on public.churn_analyses for all
  using (auth.uid() = user_id);
