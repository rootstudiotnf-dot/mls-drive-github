-- MLS Drive — Fase 6: vídeo (procesado, reproductor y comentarios con marca de tiempo)
--
-- REAPLICABLE (idempotente). NO cambia `can_access`: solo añade los permisos de comentar al catálogo, la tabla
-- de trabajos de vídeo, los comentarios y la regla «un vídeo no se publica hasta estar procesado».
-- (La petición original numeraba esta migración como 0005; esa numeración ya la usa la Fase 5.)

-- ---------------------------------------------------------------------------
-- Permisos de comentar (videos.comment, photos.comment, beats.comment)
-- ---------------------------------------------------------------------------
alter table public.permissions drop constraint if exists permissions_action_check;
alter table public.permissions add constraint permissions_action_check
  check (action in ('view','download','upload','edit','delete','publish','invite','manage','comment'));

-- Solo la primera vez que se crea cada permiso se reparte por defecto (volver a aplicar no pisa ediciones de roles).
-- El owner es un rol bloqueado: su trigger de protección se salta solo durante la siembra.
do $$
declare
  v record;
begin
  drop trigger if exists protect_locked_role_permissions on public.role_permissions;
  for v in select * from (values
    ('videos.comment', 'videos', 'Comentar vídeos'),
    ('photos.comment', 'photos', 'Comentar fotos'),
    ('beats.comment',  'beats',  'Comentar beats')
  ) as t(key, area, description)
  loop
    if not exists (select 1 from public.permissions where key = v.key) then
      insert into public.permissions (key, area, action, description) values (v.key, v.area, 'comment', v.description);
      -- owner y admin: todos; artist: vídeos y beats
      insert into public.role_permissions (role_id, permission_key)
      select r.id, v.key from public.roles r
      where r.key in ('owner', 'admin') or (r.key = 'artist' and v.key in ('videos.comment', 'beats.comment'))
      on conflict (role_id, permission_key) do nothing;
    end if;
  end loop;
  create trigger protect_locked_role_permissions
    before insert or update or delete on public.role_permissions
    for each row execute function public.protect_locked_role_permissions();
end $$;

-- ---------------------------------------------------------------------------
-- Metadatos del vídeo y derivado «poster»
-- ---------------------------------------------------------------------------
alter table public.assets add column if not exists meta jsonb not null default '{}'::jsonb;

-- (ADD VALUE no puede usarse en la misma transacción en la que se crea: aquí solo se añade)
alter type public.derivative_type add value if not exists 'poster';

-- ---------------------------------------------------------------------------
-- Trabajos de procesado de vídeo
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.video_job_status as enum ('queued', 'processing', 'ready', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.video_jobs (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets (id) on delete cascade,
  status        public.video_job_status not null default 'queued',
  attempts      integer not null default 0,
  error         text,
  requested_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
-- Un solo trabajo activo por asset
create unique index if not exists video_jobs_one_active_per_asset
  on public.video_jobs (asset_id) where status in ('queued', 'processing');
create index if not exists video_jobs_asset_idx on public.video_jobs (asset_id, requested_at desc);
create index if not exists video_jobs_pending_idx on public.video_jobs (status, requested_at) where status in ('queued', 'processing');

-- Nonces de los callbacks firmados (anti-repetición): la clave primaria rechaza un nonce ya usado
create table if not exists public.transcoder_nonces (
  nonce      text primary key,
  created_at timestamptz not null default now()
);
create index if not exists transcoder_nonces_created_idx on public.transcoder_nonces (created_at);

alter table public.video_jobs enable row level security;
alter table public.transcoder_nonces enable row level security;

-- Lectura: quien administra (owner/admin). Escritura: solo desde servidor (service role).
drop policy if exists video_jobs_select on public.video_jobs;
create policy video_jobs_select on public.video_jobs for select to authenticated
  using (public.has_admin_permission());

revoke all on public.video_jobs, public.transcoder_nonces from anon, authenticated;
grant select on public.video_jobs to authenticated;

-- ---------------------------------------------------------------------------
-- Un vídeo no se publica hasta que su trabajo está 'ready'
-- ---------------------------------------------------------------------------
create or replace function public.enforce_video_ready_to_publish()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.visibility = 'published' and old.visibility is distinct from 'published' and new.kind = 'video' then
    if not exists (select 1 from public.video_jobs j where j.asset_id = new.id and j.status = 'ready') then
      raise exception 'El vídeo aún no está procesado: no se puede publicar' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists assets_video_ready_to_publish on public.assets;
create trigger assets_video_ready_to_publish
  before update of visibility on public.assets
  for each row execute function public.enforce_video_ready_to_publish();

-- ---------------------------------------------------------------------------
-- Comentarios (vídeo ahora; audio en la Fase 7)
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references public.assets (id) on delete cascade,
  user_id      uuid references public.profiles (id) on delete set null,
  parent_id    uuid references public.comments (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 2000),
  timecode_ms  integer check (timecode_ms is null or timecode_ms >= 0),
  resolved     boolean not null default false,
  resolved_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  deleted_at   timestamptz
);
create index if not exists comments_asset_time_idx on public.comments (asset_id, timecode_ms, created_at) where deleted_at is null;
create index if not exists comments_parent_idx on public.comments (parent_id) where parent_id is not null;
create index if not exists comments_user_recent_idx on public.comments (user_id, created_at desc);

-- Una respuesta es del mismo asset que su comentario padre
create or replace function public.comments_check_parent()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.parent_id is not null and not exists (
    select 1 from public.comments p where p.id = new.parent_id and p.asset_id = new.asset_id
  ) then
    raise exception 'La respuesta debe ser del mismo archivo que el comentario' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists comments_check_parent on public.comments;
create trigger comments_check_parent before insert or update of parent_id on public.comments
  for each row execute function public.comments_check_parent();

alter table public.comments enable row level security;

-- Se ven los comentarios de los assets a los que se puede acceder (si pierdes el acceso, dejas de verlos)
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated
  using (deleted_at is null and public.can_access((select auth.uid()), 'view', 'asset', asset_id));

revoke all on public.comments from anon, authenticated;
grant select on public.comments to authenticated;

-- ¿Puede este usuario comentar este asset? Ver el asset + el permiso <área>.comment de su rol.
create or replace function public.can_comment(p_user uuid, p_asset uuid)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  v_kind public.asset_kind;
  v_area text;
begin
  select kind into v_kind from public.assets where id = p_asset and deleted_at is null;
  if not found then return false; end if;
  v_area := case when v_kind = 'photo' then 'photos' when v_kind = 'video' then 'videos' when v_kind = 'audio' then 'beats' else null end;
  if v_area is null then return false; end if;
  return public.can_access(p_user, 'view', 'asset', p_asset) and public.has_permission(p_user, v_area || '.comment');
end $$;

-- Nº de comentarios por vídeo (para las rejillas): invoker, cuenta solo lo que RLS deja ver
create or replace function public.comment_counts(p_assets uuid[])
returns table (asset_id uuid, total bigint, pending bigint)
language sql stable security invoker set search_path = ''
as $$
  select c.asset_id, count(*)::bigint, count(*) filter (where not c.resolved and c.parent_id is null)::bigint
  from public.comments c
  where c.asset_id = any(p_assets) and c.deleted_at is null
  group by c.asset_id
$$;

revoke execute on function
  public.enforce_video_ready_to_publish(), public.comments_check_parent(),
  public.can_comment(uuid, uuid), public.comment_counts(uuid[])
from public, anon, authenticated;
grant execute on function public.comment_counts(uuid[]) to authenticated;
grant execute on function public.can_comment(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Uso de almacenamiento: los derivados se desglosan por tipo (miniatura, web, proxy, póster)
-- ---------------------------------------------------------------------------
create or replace function public.storage_usage()
returns table (kind text, artist_id uuid, files bigint, bytes bigint)
language sql stable security definer set search_path = ''
as $$
  select a.kind::text, a.artist_id, count(*)::bigint, coalesce(sum(a.size_bytes), 0)::bigint
  from public.assets a
  where a.status = 'ready' and a.deleted_at is null
  group by a.kind, a.artist_id
  union all
  select 'derivative:' || d.type::text, null::uuid, count(*)::bigint, coalesce(sum(d.size_bytes), 0)::bigint
  from public.asset_derivatives d
  join public.assets a on a.id = d.asset_id
  where d.status = 'ready' and a.deleted_at is null
  group by d.type
$$;
