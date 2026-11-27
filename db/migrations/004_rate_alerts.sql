-- Alerts raised when the reference rate changes. History is kept; reads are per user.
create table if not exists rate_alert (
  id bigserial primary key,
  currency text not null,
  previous_rate numeric(18, 6),
  new_rate numeric(18, 6) not null,
  direction text not null check (direction in ('up', 'down', 'first')),
  created_at timestamptz not null default now()
);

create index if not exists rate_alert_created_idx on rate_alert (created_at desc);

create table if not exists rate_alert_read (
  alert_id bigint not null references rate_alert (id) on delete cascade,
  user_email text not null,
  read_at timestamptz not null default now(),
  primary key (alert_id, user_email)
);
