-- Run this once in Supabase Dashboard -> SQL Editor.
create table if not exists public.bead_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  total integer,
  created_at timestamptz not null default now()
);

alter table public.bead_projects
  add column if not exists status text not null default 'planned',
  add column if not exists group_name text,
  add column if not exists image_path text;

alter table public.bead_projects drop constraint if exists bead_projects_status_check;
alter table public.bead_projects add constraint bead_projects_status_check
  check (status in ('planned', 'completed', 'cancelled'));

create table if not exists public.bead_project_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.bead_projects(id) on delete cascade,
  code text not null,
  count integer not null check (count >= 0),
  unique (project_id, code)
);

create table if not exists public.user_inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  quantity integer not null default 1000 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, code)
);

alter table public.bead_projects enable row level security;
alter table public.bead_project_items enable row level security;
alter table public.user_inventory enable row level security;

drop policy if exists "Users manage their own projects" on public.bead_projects;
create policy "Users manage their own projects" on public.bead_projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users manage items in their projects" on public.bead_project_items;
create policy "Users manage items in their projects" on public.bead_project_items
  for all using (
    exists (select 1 from public.bead_projects p where p.id = project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.bead_projects p where p.id = project_id and p.user_id = auth.uid())
  );

drop policy if exists "Users manage their own inventory" on public.user_inventory;
create policy "Users manage their own inventory" on public.user_inventory
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('project-images', 'project-images', false)
on conflict (id) do update set public = false;

drop policy if exists "Users read their project images" on storage.objects;
create policy "Users read their project images" on storage.objects
  for select using (
    bucket_id = 'project-images' and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "Users upload their project images" on storage.objects;
create policy "Users upload their project images" on storage.objects
  for insert with check (
    bucket_id = 'project-images' and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "Users update their project images" on storage.objects;
create policy "Users update their project images" on storage.objects
  for update using (
    bucket_id = 'project-images' and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "Users delete their project images" on storage.objects;
create policy "Users delete their project images" on storage.objects
  for delete using (
    bucket_id = 'project-images' and split_part(name, '/', 1) = auth.uid()::text
  );
