-- agents-cli cross-machine sync backend.
-- Stores ONLY client-side-encrypted envelopes (AES-256-GCM). The server never
-- sees plaintext; RLS gates which user can read/write which row or object.
-- See epic phnx-labs/agents-cli#363.

-- ── secrets: one encrypted envelope per (user, bundle name) ──────────────────
create table if not exists public.secret_bundles (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  name       text        not null,
  envelope   jsonb       not null,            -- {v,kdf,iter,salt,iv,ct,tag}
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

alter table public.secret_bundles enable row level security;

drop policy if exists "own secret bundles" on public.secret_bundles;
create policy "own secret bundles" on public.secret_bundles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── sessions: metadata row; the encrypted JSONL blob lives in Storage ────────
create table if not exists public.session_blobs (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  session_id text        not null,
  agent      text,
  updated_at timestamptz not null default now(),
  primary key (user_id, session_id)
);

alter table public.session_blobs enable row level security;

drop policy if exists "own session metadata" on public.session_blobs;
create policy "own session metadata" on public.session_blobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── storage bucket for encrypted session transcripts (private) ───────────────
insert into storage.buckets (id, name, public)
  values ('session-blobs', 'session-blobs', false)
  on conflict (id) do nothing;

-- objects are namespaced by user: <auth.uid()>/<session_id>.enc
drop policy if exists "own session objects" on storage.objects;
create policy "own session objects" on storage.objects
  for all
  using      (bucket_id = 'session-blobs' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'session-blobs' and (storage.foldername(name))[1] = auth.uid()::text);
