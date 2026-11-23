-- YogAI My Health: run ONCE in Supabase > SQL Editor. Safe to re-run (uses IF NOT EXISTS / DROP POLICY IF EXISTS).
-- Everything is private: each row belongs to one user and Row Level Security only lets that user touch it.

create table if not exists public.health_reports (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  test_date         date not null,                    -- the ACTUAL test/collection date, confirmed by the user
  lab_name          text,
  sex_context       text check (sex_context in ('male','female')),
  adult_confirmed   boolean not null default false,   -- built-in adult ranges are only used when true
  source_type       text check (source_type in ('pdf','image')),
  extraction_method text check (extraction_method in ('text','ocr','mixed','manual')),
  file_path         text,                             -- private storage path: <user_id>/<random>-<filename>
  file_name         text,
  file_mime         text,
  created_at        timestamptz not null default now()
);
create index if not exists health_reports_user_date on public.health_reports (user_id, test_date desc);

create table if not exists public.health_results (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references public.health_reports(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  test_date         date not null,
  standard_key      text,                             -- e.g. 'hemoglobin' (null for tests not in the built-in list)
  standard_name     text not null,
  original_name     text not null,                    -- name exactly as printed in the report
  grp               text not null,
  value_num         numeric,
  value_text        text,
  qualifier         text check (qualifier in ('<','<=','>','>=')),
  unit              text,
  ref_text          text,                             -- reference range as printed / confirmed by the user
  flag              text,
  status            text check (status in ('normal','low','high','verify')),
  extraction_source text check (extraction_source in ('text','ocr','manual')),
  user_verified     boolean not null default true,
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists health_results_user_date on public.health_results (user_id, test_date desc);
create index if not exists health_results_report on public.health_results (report_id);
create index if not exists health_results_key on public.health_results (user_id, standard_key);

alter table public.health_reports enable row level security;
alter table public.health_results enable row level security;

drop policy if exists "health_reports_select_own" on public.health_reports;
drop policy if exists "health_reports_insert_own" on public.health_reports;
drop policy if exists "health_reports_update_own" on public.health_reports;
drop policy if exists "health_reports_delete_own" on public.health_reports;
create policy "health_reports_select_own" on public.health_reports for select to authenticated using (auth.uid() = user_id);
create policy "health_reports_insert_own" on public.health_reports for insert to authenticated with check (auth.uid() = user_id);
create policy "health_reports_update_own" on public.health_reports for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "health_reports_delete_own" on public.health_reports for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "health_results_select_own" on public.health_results;
drop policy if exists "health_results_insert_own" on public.health_results;
drop policy if exists "health_results_update_own" on public.health_results;
drop policy if exists "health_results_delete_own" on public.health_results;
create policy "health_results_select_own" on public.health_results for select to authenticated using (auth.uid() = user_id);
create policy "health_results_insert_own" on public.health_results for insert to authenticated
  with check (auth.uid() = user_id and exists (select 1 from public.health_reports r where r.id = report_id and r.user_id = auth.uid()));
create policy "health_results_update_own" on public.health_results for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "health_results_delete_own" on public.health_results for delete to authenticated using (auth.uid() = user_id);

-- Private storage bucket for the original files (never public)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('health-reports', 'health-reports', false, 15728640, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = 15728640, allowed_mime_types = array['application/pdf','image/jpeg','image/png'];

drop policy if exists "health_files_select_own" on storage.objects;
drop policy if exists "health_files_insert_own" on storage.objects;
drop policy if exists "health_files_delete_own" on storage.objects;
create policy "health_files_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'health-reports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "health_files_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'health-reports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "health_files_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'health-reports' and (storage.foldername(name))[1] = auth.uid()::text);

-- Sanity checks you can run afterwards (should both return 'true'):
--   select relrowsecurity from pg_class where relname = 'health_results';
--   select not public from storage.buckets where id = 'health-reports';
