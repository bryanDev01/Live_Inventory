-- Each product can have its own minimum profit over cost. The default is the owner-confirmed 10%.
alter table product add column if not exists profit_limit numeric(5, 2) not null default 10;

alter table product drop constraint if exists product_profit_limit_check;
alter table product add constraint product_profit_limit_check check (profit_limit >= 0);

-- Alerts raised when a product falls to or below its limit. They never mention who changed the rate.
create table if not exists product_alert (
  id bigserial primary key,
  product_id uuid,
  product_name text not null,
  profit_percent numeric(18, 6) not null,
  profit_limit numeric(5, 2) not null,
  rate numeric(18, 6) not null,
  created_at timestamptz not null default now()
);

create index if not exists product_alert_created_idx on product_alert (created_at desc);

create table if not exists product_alert_read (
  alert_id bigint not null references product_alert (id) on delete cascade,
  user_email text not null,
  read_at timestamptz not null default now(),
  primary key (alert_id, user_email)
);
