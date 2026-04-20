create table public.founder_metrics (
  user_id               uuid references public.users primary key,
  churn_rate            decimal(5,2),
  avg_customer_tenure   decimal(8,2),
  mrr                   decimal(10,2),
  mrr_lost_30d          decimal(10,2),
  mrr_bracket           text,
  dominant_churn_cause  text,
  cumulative_mrr_protected decimal(10,2) default 0,
  computed_at           timestamptz default now()
);

alter table public.founder_metrics enable row level security;

create policy "Users see own metrics"
  on public.founder_metrics for all
  using (auth.uid() = user_id);
