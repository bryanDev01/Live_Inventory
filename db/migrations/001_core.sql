-- Core schema for the private inventory.
-- Additive only: every statement is safe to run more than once.

-- Maps the name a user types to the internal email Neon Auth knows.
create table if not exists app_user (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text not null unique,
  created_at timestamptz not null default now()
);

-- Exchange rates are append-only history. Values are stored exactly as delivered.
create table if not exists exchange_rate (
  id bigserial primary key,
  currency text not null,
  cup_per_unit numeric(18, 6) not null check (cup_per_unit > 0),
  source text not null check (source in ('manual', 'eltoque')),
  observed_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  unique (currency, source, observed_at)
);

-- One row per product. Derived values (CUP equivalent, profit) are computed, never stored.
create table if not exists product (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  purchase_amount numeric(18, 2) not null check (purchase_amount >= 0),
  purchase_currency text not null default 'USD',
  sale_amount numeric(18, 2) not null check (sale_amount >= 0),
  sale_currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_name_idx on product (lower(name));

-- Small key/value settings, for example which profit mode is shown first.
create table if not exists app_setting (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Names are compared case-insensitively at login, so the database must enforce that uniqueness too.
create unique index if not exists app_user_name_lower_idx on app_user (lower(name));
