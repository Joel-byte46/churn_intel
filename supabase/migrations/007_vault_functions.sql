create extension if not exists supabase_vault;

-- Stockage de la clé Anthropic
create or replace function store_anthropic_key(
  p_user_id uuid,
  p_key     text
)
returns void
language plpgsql
security definer
as $$
declare
  v_name text := 'anthropic_key_' || p_user_id::text;
  v_existing_id uuid;
begin
  select id into v_existing_id
  from vault.secrets
  where name = v_name;

  if v_existing_id is not null then
    perform vault.update_secret(v_existing_id, p_key);
  else
    perform vault.create_secret(p_key, v_name, 'Anthropic key — ' || p_user_id::text);
  end if;
end;
$$;

-- Lecture de la clé Anthropic
create or replace function get_anthropic_key(p_user_id uuid)
returns text
language plpgsql
security definer
as $$
declare
  v_key text;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'anthropic_key_' || p_user_id::text;

  if v_key is null then
    raise exception 'No Anthropic key for user %', p_user_id;
  end if;

  return v_key;
end;
$$;

revoke execute on function store_anthropic_key from public;
revoke execute on function get_anthropic_key   from public;

grant execute on function store_anthropic_key to service_role;
grant execute on function get_anthropic_key   to service_role;


create or replace function increment_mrr_protected(
  p_user_id uuid,
  p_amount  decimal
)
returns void
language plpgsql
security definer
as $$
begin
  update public.founder_metrics
  set cumulative_mrr_protected = cumulative_mrr_protected + p_amount
  where user_id = p_user_id;
end;
$$;

grant execute on function increment_mrr_protected to service_role;


-- 007_vault_functions.sql — ajout

create or replace function store_stripe_key(
  p_user_id uuid,
  p_key     text
)
returns void
language plpgsql
security definer
as $$
declare
  v_name text := 'stripe_key_' || p_user_id::text;
  v_existing_id uuid;
begin
  select id into v_existing_id
  from vault.secrets
  where name = v_name;

  if v_existing_id is not null then
    perform vault.update_secret(v_existing_id, p_key);
  else
    perform vault.create_secret(
      p_key,
      v_name,
      'Stripe restricted key — ' || p_user_id::text
    );
  end if;
end;
$$;

create or replace function get_stripe_key(p_user_id uuid)
returns text
language plpgsql
security definer
as $$
declare
  v_key text;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'stripe_key_' || p_user_id::text;

  if v_key is null then
    raise exception 'No Stripe key for user %', p_user_id;
  end if;

  return v_key;
end;
$$;

revoke execute on function store_stripe_key from public;
revoke execute on function get_stripe_key   from public;
grant execute on function store_stripe_key  to service_role;
grant execute on function get_stripe_key    to service_role;
