-- 在线用户与多人参与记录
create table if not exists public.workspace_presence (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  seen_at timestamptz not null default now()
);

create table if not exists public.task_participants (
  sample_id integer not null references public.tasks(sample_id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  nickname text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (sample_id, user_id)
);

create index if not exists task_participants_user_idx on public.task_participants(user_id);
create index if not exists workspace_presence_seen_idx on public.workspace_presence(seen_at);

create or replace function public.record_workspace_presence(p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_user_id uuid;
begin
  select id into v_user_id from public.app_users where access_token = p_token;
  if v_user_id is null then raise exception '登录已失效'; end if;
  insert into public.workspace_presence(user_id, seen_at) values(v_user_id, now())
  on conflict(user_id) do update set seen_at = excluded.seen_at;
end;
$$;

create or replace function public.get_workspace_presence(p_token uuid)
returns table(user_id uuid, nickname text, seen_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.app_users where access_token = p_token) then raise exception '登录已失效'; end if;
  delete from public.workspace_presence where seen_at < now() - interval '90 seconds';
  return query select au.id, au.nickname, wp.seen_at
  from public.workspace_presence wp join public.app_users au on au.id = wp.user_id
  order by wp.seen_at desc;
end;
$$;

create or replace function public.get_task_participants(p_token uuid)
returns table(sample_id integer, user_id uuid, nickname text, first_seen_at timestamptz, last_seen_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists(select 1 from public.app_users where access_token = p_token) then raise exception '登录已失效'; end if;
  return query select tp.sample_id, tp.user_id, tp.nickname, tp.first_seen_at, tp.last_seen_at
  from public.task_participants tp order by tp.last_seen_at desc;
end;
$$;

create or replace function public.save_workspace_task(p_token uuid, p_sample_id integer, p_revision integer, p_corrected_text text, p_status text, p_labels jsonb, p_reviewer_note text)
returns tasks language plpgsql security definer set search_path = public as $$
declare v_name text; v_user_id uuid; v_result public.tasks;
begin
  select id, nickname into v_user_id, v_name from public.app_users where access_token = p_token;
  if v_name is null then raise exception '登录已失效'; end if;
  update public.tasks set corrected_text = p_corrected_text, status = p_status,
    labels = coalesce(p_labels, '{}'::jsonb), reviewer_note = coalesce(p_reviewer_note, ''),
    annotator_id = null, annotator_name = v_name
  where sample_id = p_sample_id and revision = p_revision returning * into v_result;
  if v_result.sample_id is null then raise exception '记录已被其他人修改，请刷新后重试'; end if;
  insert into public.task_participants(sample_id, user_id, nickname, first_seen_at, last_seen_at)
  values(p_sample_id, v_user_id, v_name, now(), now())
  on conflict(sample_id, user_id) do update set nickname=excluded.nickname, last_seen_at=excluded.last_seen_at;
  return v_result;
end;
$$;
