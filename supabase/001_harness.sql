-- Apply once to a dedicated Supabase project, through its SQL editor or migration CLI.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table public.harness_releases (
  owner_id uuid not null references auth.users(id),
  version text not null,
  digest text not null,
  model text not null,
  dimensions integer not null check (dimensions between 1 and 4096),
  documents jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, version)
);
create table public.harness_embeddings (
  owner_id uuid not null references auth.users(id),
  model text not null,
  content_hash text not null,
  dimensions integer not null check (dimensions between 1 and 4096),
  embedding extensions.vector not null,
  primary key(owner_id, model, content_hash),
  check (extensions.vector_dims(embedding) = dimensions)
);
create table public.harness_chunks (
  owner_id uuid not null,
  version text not null,
  chunk_id text not null,
  model text not null,
  content_hash text not null,
  document_id text not null,
  title text not null,
  heading text not null,
  domain text not null check(domain in ('engineering','communication')),
  source_url text not null,
  content text not null,
  primary key(owner_id, version, chunk_id),
  foreign key(owner_id, version) references public.harness_releases(owner_id, version),
  foreign key(owner_id, model, content_hash) references public.harness_embeddings(owner_id, model, content_hash)
);

alter table public.harness_releases enable row level security;
alter table public.harness_embeddings enable row level security;
alter table public.harness_chunks enable row level security;
revoke all on public.harness_releases, public.harness_embeddings, public.harness_chunks from anon, authenticated;
grant select on public.harness_releases, public.harness_embeddings, public.harness_chunks to authenticated;
grant all on public.harness_releases, public.harness_embeddings, public.harness_chunks to service_role;
create policy harness_release_read on public.harness_releases for select to authenticated using (owner_id = (select auth.uid()));
create policy harness_embedding_read on public.harness_embeddings for select to authenticated using (owner_id = (select auth.uid()));
create policy harness_chunk_read on public.harness_chunks for select to authenticated using (owner_id = (select auth.uid()));

-- One RPC transaction: incomplete ingestion cannot become a visible release.
create function public.publish_harness_release(p_owner uuid, p_release jsonb, p_model text, p_dimensions integer, p_chunks jsonb)
returns void language plpgsql security invoker set search_path = public, extensions as $$
declare existing public.harness_releases; item jsonb;
begin
  if p_model = '' or p_dimensions not between 1 and 4096 then raise exception 'Invalid embedding configuration'; end if;
  -- Serialize concurrent publication of the same owner/version.
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || ':' || (p_release->>'version'), 0));
  select * into existing from public.harness_releases where owner_id=p_owner and version=p_release->>'version';
  if found then
    if existing.digest=p_release->>'digest' and existing.model=p_model and existing.dimensions=p_dimensions then return; end if;
    raise exception 'Release version is immutable';
  end if;
  insert into public.harness_releases(owner_id,version,digest,model,dimensions,documents)
  values(p_owner,p_release->>'version',p_release->>'digest',p_model,p_dimensions,p_release->'documents');
  for item in select value from jsonb_array_elements(p_chunks) loop
    if jsonb_array_length(item->'embedding') <> p_dimensions then raise exception 'Embedding dimension mismatch'; end if;
    insert into public.harness_embeddings(owner_id,model,content_hash,dimensions,embedding)
    values(p_owner,p_model,item->>'contentHash',p_dimensions,(item->>'embedding')::extensions.vector)
    on conflict(owner_id,model,content_hash) do nothing;
    if exists(select 1 from public.harness_embeddings where owner_id=p_owner and model=p_model and content_hash=item->>'contentHash' and dimensions<>p_dimensions) then raise exception 'Model configuration changed'; end if;
    insert into public.harness_chunks(owner_id,version,chunk_id,model,content_hash,document_id,title,heading,domain,source_url,content)
    values(p_owner,p_release->>'version',item->>'id',p_model,item->>'contentHash',item->>'documentId',item->>'title',item->>'heading',item->>'domain',item->>'sourceUrl',item->>'content');
  end loop;
end $$;
revoke all on function public.publish_harness_release(uuid,jsonb,text,integer,jsonb) from public, anon, authenticated;
grant execute on function public.publish_harness_release(uuid,jsonb,text,integer,jsonb) to service_role;

create function public.search_harness(p_version text, p_model text, p_vector extensions.vector, p_domain text default null, p_limit integer default 5)
returns table(chunk_id text, document_id text, title text, heading text, source_url text, content text, similarity double precision)
language plpgsql stable security invoker set search_path = public, extensions as $$
declare dims integer;
begin
  select dimensions into dims from public.harness_releases where owner_id=auth.uid() and version=p_version and model=p_model;
  if dims is null then raise exception 'Release unavailable for this user or model'; end if;
  if vector_dims(p_vector)<>dims then raise exception 'Query embedding dimension mismatch'; end if;
  return query select c.chunk_id,c.document_id,c.title,c.heading,c.source_url,c.content,1-(e.embedding <=> p_vector)
  from public.harness_chunks c join public.harness_embeddings e on e.owner_id=c.owner_id and e.model=c.model and e.content_hash=c.content_hash
  where c.owner_id=auth.uid() and c.version=p_version and c.model=p_model and (p_domain is null or c.domain=p_domain)
  order by e.embedding <=> p_vector limit greatest(1,least(p_limit,10));
end $$;
revoke all on function public.search_harness(text,text,extensions.vector,text,integer) from public, anon;
grant execute on function public.search_harness(text,text,extensions.vector,text,integer) to authenticated;
