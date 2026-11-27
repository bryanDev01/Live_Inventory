-- One row per browser or device that agreed to receive push notifications.
create table if not exists push_subscription (
  id bigserial primary key,
  user_email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscription_user_idx on push_subscription (lower(user_email));
