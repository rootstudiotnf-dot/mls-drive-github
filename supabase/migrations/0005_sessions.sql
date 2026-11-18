-- MLS Drive — Fase 5: sesiones de fotos (galerías, favoritas y descargas)
--
-- REAPLICABLE (idempotente). Amplía la regla de acceso `can_access` (Fase 2) en DOS puntos y solo en esos:
--   1) un artista PARTICIPANTE de una sesión accede a sus assets igual que el artista principal;
--   2) descargar algo que está dentro de una sesión exige que la sesión permita descargas
--      (`download_mode <> 'off'`). La variante (web/original) la aplica `getAssetUrl`.
-- El resto de la regla (rol = techo, alcance, visibilidad, Vault, `downloadable`) no cambia.
--
-- (La petición original numeraba esta migración como 0004; esa numeración ya la usa la Fase 4.)

-- ---------------------------------------------------------------------------
-- Tipos y columnas
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.session_download_mode as enum ('off', 'web', 'original');
exception when duplicate_object then null; end $$;

alter table public.sessions
  add column if not exists cover_asset_id uuid references public.assets (id) on delete set null,
  add column if not exists download_mode public.session_download_mode not null default 'off',
  add column if not exists sort integer not null default 0;
create index if not exists sessions_cover_asset_id_idx on public.sessions (cover_asset_id);
create index if not exists sessions_artist_date_idx on public.sessions (artist_id, date desc nulls last, created_at desc) where deleted_at is null;

-- Artistas participantes además del principal
create table if not exists public.session_participants (
  session_id uuid not null references public.sessions (id) on delete cascade,
  artist_id  uuid not null references public.artists (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, artist_id)
);
create index if not exists session_participants_artist_id_idx on public.session_participants (artist_id);

-- Carpetas dentro de una sesión (p. ej. «Selección», «Detrás de cámaras»)
alter table public.folders
  add column if not exists session_id uuid references public.sessions (id) on delete cascade;
create index if not exists folders_session_id_idx on public.folders (session_id) where session_id is not null;

-- El nombre es único por (artista, sesión, carpeta madre) entre las no borradas: dos sesiones pueden tener «Selección»
drop index if exists public.folders_unique_name_per_parent;
create unique index if not exists folders_unique_name_per_parent
  on public.folders (
    artist_id,
    coalesce(session_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  )
  where deleted_at is null;

-- Las carpetas base del artista NO son las de las sesiones
create or replace function public.create_artist_defaults(p_artist uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.folders (artist_id, parent_id, name, kind, sort)
  select p_artist, null, v.name, v.kind::public.folder_kind, v.sort
  from (values ('Fotos', 'photos', 0), ('Vídeos', 'videos', 1), ('Archivos', 'files', 2)) as v(name, kind, sort)
  where not exists (
    select 1 from public.folders f
    where f.artist_id = p_artist and f.session_id is null and f.parent_id is null
      and lower(f.name) = lower(v.name) and f.deleted_at is null
  );
end $$;

-- Assets: color medio (marcador mientras carga la miniatura) y orden manual dentro de la sesión
alter table public.assets
  add column if not exists avg_color text,
  add column if not exists sort_index integer;
alter table public.assets drop constraint if exists assets_avg_color_check;
alter table public.assets add constraint assets_avg_color_check
  check (avg_color is null or avg_color ~ '^#[0-9a-f]{6}$');

create index if not exists assets_session_sort_idx
  on public.assets (session_id, sort_index, created_at) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Favoritas
-- ---------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  asset_id   uuid not null references public.assets (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, asset_id)
);
create index if not exists favorites_asset_id_idx on public.favorites (asset_id);

alter table public.session_participants enable row level security;
alter table public.favorites enable row level security;

-- Cada persona lee las suyas. Quien puede EDITAR o PUBLICAR ese asset (rol + alcance: puede
-- publicar/editar sobre el artista) lee las de los demás. Las escrituras van por acciones de servidor
-- (los clientes no escriben en la base de datos).
drop policy if exists favorites_select on public.favorites;
create policy favorites_select on public.favorites for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.can_access((select auth.uid()), 'edit', 'asset', asset_id)
    or public.can_access((select auth.uid()), 'publish', 'asset', asset_id)
  );

drop policy if exists session_participants_select on public.session_participants;
create policy session_participants_select on public.session_participants for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'session', session_id));

revoke all on public.session_participants, public.favorites from anon, authenticated;
grant select on public.session_participants, public.favorites to authenticated;

-- ---------------------------------------------------------------------------
-- can_access (Fase 2) con las dos ampliaciones de la Fase 5 (marcadas con «Fase 5»)
-- ---------------------------------------------------------------------------
create or replace function public.can_access(
  p_user uuid, p_action text, p_resource_type text, p_resource_id uuid
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_role_id uuid; v_role_key text; v_scope text;
  v_area text;
  v_artist uuid; v_session uuid; v_folder uuid; v_asset uuid; v_beat uuid;
  v_visibility text; v_uploaded_by uuid; v_downloadable boolean;
  v_is_vault boolean := false;
  a public.assets%rowtype;
  b public.beats%rowtype;
  s public.sessions%rowtype;
  f public.folders%rowtype;
  ar public.artists%rowtype;
begin
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;
  if p_user is null or p_action is null
     or p_action not in ('view', 'download', 'upload', 'edit', 'delete', 'publish') then
    return false;
  end if;

  select p.role_id, r.key, r.scope into v_role_id, v_role_key, v_scope
  from public.profiles p join public.roles r on r.id = p.role_id
  where p.id = p_user and p.status = 'active';
  if not found then return false; end if;

  if p_resource_type = 'vault' then
    v_is_vault := true; v_area := 'vault';

  elsif p_resource_type = 'asset' then
    select * into a from public.assets where id = p_resource_id and deleted_at is null;
    if not found then return false; end if;
    if a.artist_id is not null and exists (
         select 1 from public.artists x where x.id = a.artist_id and x.deleted_at is not null) then return false; end if;
    if a.session_id is not null and exists (
         select 1 from public.sessions x where x.id = a.session_id and x.deleted_at is not null) then return false; end if;
    v_asset := a.id; v_artist := a.artist_id; v_session := a.session_id; v_folder := a.folder_id;
    v_is_vault := (a.space = 'vault');
    v_area := case when v_is_vault then 'vault'
                   when a.kind = 'photo' then 'photos'
                   when a.kind = 'video' then 'videos'
                   else 'files' end;
    v_visibility := a.visibility::text; v_uploaded_by := a.uploaded_by; v_downloadable := a.downloadable;

  elsif p_resource_type = 'beat' then
    select * into b from public.beats where id = p_resource_id and deleted_at is null;
    if not found then return false; end if;
    if not exists (select 1 from public.assets x where x.id = b.asset_id and x.deleted_at is null) then
      return false;
    end if;
    v_beat := b.id; v_area := 'beats';
    v_visibility := case when b.status = 'published' then 'published' else 'private' end;
    v_uploaded_by := b.created_by; v_downloadable := b.downloadable;

  elsif p_resource_type = 'artist' then
    select * into ar from public.artists where id = p_resource_id and deleted_at is null;
    if not found then return false; end if;
    v_artist := ar.id;

  elsif p_resource_type = 'session' then
    select * into s from public.sessions where id = p_resource_id and deleted_at is null;
    if not found then return false; end if;
    if exists (select 1 from public.artists x where x.id = s.artist_id and x.deleted_at is not null) then
      return false;
    end if;
    v_session := s.id; v_artist := s.artist_id;

  elsif p_resource_type = 'folder' then
    select * into f from public.folders where id = p_resource_id;
    if not found then return false; end if;
    if exists (select 1 from public.artists x where x.id = f.artist_id and x.deleted_at is not null) then
      return false;
    end if;
    v_folder := f.id; v_artist := f.artist_id;
    v_session := f.session_id; -- Fase 5: una carpeta de sesión hereda el acceso de la sesión
    v_area := case when f.kind = 'photos' then 'photos' when f.kind = 'videos' then 'videos' else 'files' end;

  else
    return false;
  end if;

  if v_area is not null then
    if not exists (
      select 1 from public.role_permissions
      where role_id = v_role_id and permission_key = v_area || '.' || p_action
    ) then return false; end if;
  else
    if not exists (
      select 1 from public.role_permissions
      where role_id = v_role_id
        and permission_key in ('photos.' || p_action, 'videos.' || p_action, 'files.' || p_action)
    ) then return false; end if;
  end if;

  if v_is_vault then
    if v_role_key <> 'owner' and not exists (
      select 1 from public.grants g
      where g.user_id = p_user and g.resource_type = 'vault' and g.revoked_at is null
        and (g.expires_at is null or g.expires_at > now())
        and public.grant_allows(g, p_action)
    ) then return false; end if;
  else
    if v_scope = 'assigned' then
      if not (
        (v_artist is not null and exists (
           select 1 from public.artist_members m where m.artist_id = v_artist and m.user_id = p_user))
        -- Fase 5: artistas participantes de la sesión (por session_participants + artist_members)
        or (v_session is not null and exists (
           select 1 from public.session_participants sp
           join public.artist_members m on m.artist_id = sp.artist_id and m.user_id = p_user
           where sp.session_id = v_session))
        or exists (
           select 1 from public.grants g
           where g.user_id = p_user and g.revoked_at is null
             and (g.expires_at is null or g.expires_at > now())
             and public.grant_allows(g, p_action)
             and (
               (g.resource_type = 'asset'   and g.resource_id = v_asset)
               or (g.resource_type = 'beat' and g.resource_id = v_beat)
               or (g.resource_type = 'folder'  and g.resource_id in (select public.folder_ancestors(v_folder)))
               or (g.resource_type = 'session' and g.resource_id = v_session)
               or (g.resource_type = 'artist'  and g.resource_id = v_artist)
             ))
      ) then return false; end if;
    end if;
  end if;

  if v_visibility is not null and v_visibility <> 'published' and v_uploaded_by is distinct from p_user then
    if not exists (
      select 1 from public.role_permissions
      where role_id = v_role_id and permission_key in (v_area || '.edit', v_area || '.publish')
    ) then return false; end if;
  end if;

  if p_action = 'download' and v_downloadable is not null and not v_downloadable then
    return false;
  end if;

  -- Fase 5: dentro de una sesión solo se descarga si la sesión lo permite (la variante la decide getAssetUrl)
  if p_action = 'download' and v_session is not null then
    if exists (select 1 from public.sessions x where x.id = v_session and x.download_mode = 'off') then
      return false;
    end if;
  end if;

  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Funciones de apoyo
-- ---------------------------------------------------------------------------

-- Orden manual: guarda el orden de las fotos de una sesión (solo service role, tras comprobar permisos en servidor)
create or replace function public.set_session_order(p_session uuid, p_ids uuid[])
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  with ordered as (select id, ord from unnest(p_ids) with ordinality as t(id, ord))
  update public.assets a set sort_index = o.ord - 1
  from ordered o
  where a.id = o.id and a.session_id = p_session and a.deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Nº de fotos y de otros archivos por sesión (SECURITY INVOKER: cuenta solo lo que RLS deja ver)
create or replace function public.session_counts()
returns table (session_id uuid, photos bigint, others bigint)
language sql stable security invoker set search_path = ''
as $$
  select a.session_id,
         count(*) filter (where a.kind = 'photo')::bigint,
         count(*) filter (where a.kind <> 'photo')::bigint
  from public.assets a
  where a.session_id is not null and a.deleted_at is null and a.status = 'ready'
  group by a.session_id
$$;

-- Favoritas de una sesión (invoker: RLS decide si se ven solo las propias o las de todos)
create or replace function public.session_favorites(p_session uuid)
returns table (asset_id uuid, user_id uuid, created_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  select f.asset_id, f.user_id, f.created_at
  from public.favorites f
  join public.assets a on a.id = f.asset_id
  where a.session_id = p_session and a.deleted_at is null
  order by f.created_at desc
$$;

revoke execute on function
  public.set_session_order(uuid, uuid[]), public.session_counts(), public.session_favorites(uuid)
from public, anon, authenticated;
grant execute on function public.session_counts(), public.session_favorites(uuid) to authenticated;
grant execute on function public.set_session_order(uuid, uuid[]) to service_role;
