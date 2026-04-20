create table public.autopilot_jobs (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references public.users not null,
  customer_id           uuid references public.customers not null,
  action_type           text not null,
  health_score          decimal(5,2),
  trigger_data          jsonb,
  intervention          jsonb,
  status                text default 'pending',
  deployed_at           timestamptz,
  impact                jsonb,
  mrr_impact            decimal(10,2),
  created_at            timestamptz default now()
);

create index idx_autopilot_jobs_user_id     on public.autopilot_jobs(user_id);
create index idx_autopilot_jobs_status      on public.autopilot_jobs(status);
create index idx_autopilot_jobs_deployed_at on public.autopilot_jobs(deployed_at);

alter table public.autopilot_jobs enable row level security;

create policy "Users see own jobs"
  on public.autopilot_jobs for all
  using (auth.uid() = user_id);
