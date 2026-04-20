alter table public.users
  add column preferred_model text default null;

-- Contrainte : uniquement les modèles valides ou null
alter table public.users
  add constraint valid_model check (
    preferred_model is null or preferred_model in (
      'claude-sonnet-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-3-5-sonnet-20241022'
    )
  );
