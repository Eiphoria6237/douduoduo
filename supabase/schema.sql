-- Run this once in Supabase Dashboard -> SQL Editor.
create table if not exists public.bead_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  total integer,
  created_at timestamptz not null default now()
);

create table if not exists public.bead_project_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.bead_projects(id) on delete cascade,
  code text not null,
  count integer not null check (count >= 0),
  unique (project_id, code)
);

alter table public.bead_projects enable row level security;
alter table public.bead_project_items enable row level security;

create policy "Users manage their own projects" on public.bead_projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage items in their projects" on public.bead_project_items
  for all using (
    exists (select 1 from public.bead_projects p where p.id = project_id and p.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.bead_projects p where p.id = project_id and p.user_id = auth.uid())
  );
