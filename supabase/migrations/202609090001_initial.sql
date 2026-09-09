create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null default '',
  role text not null default 'annotator' check (role in ('annotator', 'reviewer', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  sample_id integer primary key,
  image_path text not null,
  original_filename text not null default '',
  batch text not null default '',
  note text not null default '',
  ocr_initial text not null default '',
  corrected_text text not null default '',
  status text not null default '待标注' check (status in ('待标注', '标注中', '待复核', '已完成', '有疑问')),
  labels jsonb not null default '{}'::jsonb,
  annotator_id uuid references auth.users(id) on delete set null,
  annotator_name text not null default '',
  reviewer_note text not null default '',
  revision integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists tasks_status_idx on public.tasks(status);
create index if not exists tasks_batch_idx on public.tasks(batch);
create index if not exists tasks_annotator_idx on public.tasks(annotator_id);

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;

create policy "authenticated users can read profiles"
on public.profiles for select to authenticated using (true);

create policy "users can update own profile"
on public.profiles for update to authenticated
using (auth.uid() = id) with check (auth.uid() = id);

create policy "authenticated users can read tasks"
on public.tasks for select to authenticated using (true);

create policy "authenticated users can update tasks"
on public.tasks for update to authenticated
using (true) with check (true);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, ''), '@', 1)), coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.touch_task()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.revision = old.revision + 1;
  return new;
end;
$$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at before update on public.tasks
for each row execute procedure public.touch_task();
