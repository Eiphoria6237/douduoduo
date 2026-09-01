alter table public.bead_projects
  add column if not exists group_name text;
