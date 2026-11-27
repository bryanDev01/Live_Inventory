-- Separates the automatic/server-side work (rate entry) from everyday product use.
alter table app_user add column if not exists role text not null default 'user';

alter table app_user drop constraint if exists app_user_role_check;
alter table app_user add constraint app_user_role_check check (role in ('admin', 'user'));
