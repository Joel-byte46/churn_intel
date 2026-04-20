create table public.benchmark_results (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references public.users not null,
  peer_count            int not null,
  benchmark             jsonb not null,
  reading               jsonb not null,
  email_sent_at         timestamptz,
  created_at            timestamptz default now()
);

alter table public.benchmark_results enable row level security;

create policy "Users see own benchmarks"
  on public.benchmark_results for all
  using (auth.uid() = user_id);
