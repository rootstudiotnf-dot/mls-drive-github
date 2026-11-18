-- MLS Drive — Fase 2: modelo de datos completo y motor de permisos
--
-- REAPLICABLE: toda la migración es idempotente (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS,
-- siembras con ON CONFLICT / WHERE NOT EXISTS). Volver a ejecutarla NO pisa los permisos que el
-- administrador haya editado ni los datos existentes.
--
-- Principio rector: DENEGAR POR DEFECTO.
--  * Todas las tablas nuevas tienen RLS activada y SOLO política de lectura, apoyada en can_access().
--  * Nadie escribe desde el cliente (sin políticas ni privilegios de escritura): todo pasa por acciones
--    de servidor que llaman antes a requirePermission().
--  * El ROL es el techo de lo que se puede hacer; un grant solo elige DÓNDE (nunca amplía el rol).
--
-- Convenciones de la regla de acceso (ver can_access más abajo):
--  * area = photos | videos | files | beats | vault (sale del recurso); action = view | download | upload |
--    edit | delete | publish.
--  * Un grant tiene flags can_view / can_download / can_upload / can_edit. 'delete' y 'publish' no tienen
--    flag propio: los habilita can_edit (siempre que el rol tenga ese permiso).
--  * artist / session: contenedores sin área propia; basta con que el rol tenga la acción en photos, videos
--    o files. folder: el área sale de folders.kind ('general' cuenta como files).
--  * Los roles NO son un enum (son una tabla editable); los tipos cerrados (kind, status, visibility…) sí.

-- ---------------------------------------------------------------------------
-- Tipos cerrados (enums). Los roles NO: viven en la tabla roles.
-- ---------------------------------------------------------------------------
do $$ begin create type public.artist_status      as enum ('active', 'archived');                       exception when duplicate_object then null; end $$;
do $$ begin create type public.session_status     as enum ('active', 'archived');                       exception when duplicate_object then null; end $$;
do $$ begin create type public.folder_kind        as enum ('photos', 'videos', 'files', 'general');     exception when duplicate_object then null; end $$;
do $$ begin create type public.asset_kind         as enum ('photo', 'video', 'audio', 'document', 'other'); exception when duplicate_object then null; end $$;
do $$ begin create type public.asset_space        as enum ('workspace', 'vault');                       exception when duplicate_object then null; end $$;
do $$ begin create type public.asset_status       as enum ('uploading', 'ready', 'failed');             exception when duplicate_object then null; end $$;
do $$ begin create type public.asset_visibility   as enum ('private', 'published');                     exception when duplicate_object then null; end $$;
do $$ begin create type public.derivative_type    as enum ('thumb', 'web', 'proxy', 'audio_preview');   exception when duplicate_object then null; end $$;
do $$ begin create type public.derivative_status  as enum ('pending', 'ready', 'failed');               exception when duplicate_object then null; end $$;
do $$ begin create type public.beat_status        as enum ('draft', 'published');                       exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Catálogo de permisos
-- ---------------------------------------------------------------------------
create table if not exists public.permissions (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,
  area         text not null check (area in ('photos','videos','files','beats','vault','users','access','roles')),
  action       text not null check (action in ('view','download','upload','edit','delete','publish','invite','manage')),
  description  text not null,
  created_at   timestamptz not null default now(),
  constraint permissions_key_is_area_action check (key = area || '.' || action)
);

insert into public.permissions (key, area, action, description)
select a.area || '.' || x.action, a.area, x.action, x.verb || ' ' || a.label
from (values
  ('photos', 'fotos'), ('videos', 'vídeos'), ('files', 'archivos'),
  ('beats', 'beats'), ('vault', 'el Vault')
) as a(area, label)
cross join (values
  ('view',     'Ver'),
  ('download', 'Descargar'),
  ('upload',   'Subir'),
  ('edit',     'Editar'),
  ('delete',   'Eliminar'),
  ('publish',  'Publicar')
) as x(action, verb)
on conflict (key) do nothing;

insert into public.permissions (key, area, action, description) values
  ('users.invite',  'users',  'invite', 'Invitar usuarios'),
  ('users.manage',  'users',  'manage', 'Gestionar usuarios (estado y rol)'),
  ('access.manage', 'access', 'manage', 'Gestionar accesos y asignaciones'),
  ('roles.manage',  'roles',  'manage', 'Gestionar roles y permisos')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Roles: campos nuevos y permisos por rol
-- ---------------------------------------------------------------------------
alter table public.roles
  add column if not exists description text not null default '',
  add column if not exists scope text not null default 'assigned' check (scope in ('all', 'assigned')),
  add column if not exists is_locked boolean not null default false;

create unique index if not exists roles_name_key on public.roles (lower(name));

create table if not exists public.role_permissions (
  id              uuid primary key default gen_random_uuid(),
  role_id         uuid not null references public.roles (id) on delete cascade,
  permission_key  text not null references public.permissions (key) on update cascade on delete cascade,
  created_at      timestamptz not null default now(),
  unique (role_id, permission_key)
);
create index if not exists role_permissions_permission_key_idx on public.role_permissions (permission_key);

-- Al reaplicar, los triggers de protección del owner se quitan mientras se siembra y se recrean después.
drop trigger if exists protect_locked_role on public.roles;
drop trigger if exists protect_locked_role_permissions on public.role_permissions;

-- Siembra por defecto (solo rellena lo que está vacío: no pisa ediciones del administrador)
update public.roles set scope = 'all',      description = 'Propietario: acceso total e inmutable.'                    where key = 'owner'        and description = '';
update public.roles set scope = 'all',      description = 'Administración completa salvo el Vault y la gestión de roles.' where key = 'admin'        and description = '';
update public.roles set scope = 'assigned', description = 'Ve y descarga el contenido de sus artistas; escucha beats.' where key = 'artist'       and description = '';
update public.roles set scope = 'assigned', description = 'Sube y edita fotos de los artistas asignados.'            where key = 'photographer' and description = '';
update public.roles set scope = 'assigned', description = 'Ve fotos, vídeos y archivos de los artistas asignados.'     where key = 'collaborator' and description = '';

-- owner: siempre todo el catálogo (también los permisos que se añadan en el futuro)
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p where r.key = 'owner'
on conflict (role_id, permission_key) do nothing;

-- Resto de roles de sistema: solo si aún no tienen ningún permiso
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
where r.key = 'admin' and p.area <> 'vault' and p.key <> 'roles.manage'
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
where r.key = 'artist'
  and p.key in ('photos.view','photos.download','videos.view','videos.download','files.view','files.download','beats.view')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
where r.key = 'photographer' and p.key in ('photos.view','photos.upload','photos.edit')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id);

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key from public.roles r cross join public.permissions p
where r.key = 'collaborator' and p.key in ('photos.view','videos.view','files.view')
  and not exists (select 1 from public.role_permissions x where x.role_id = r.id);

-- El owner queda bloqueado (después de sembrar sus permisos).
update public.roles set is_locked = true where key = 'owner' and not is_locked;

-- ---------------------------------------------------------------------------
-- Contenido
-- ---------------------------------------------------------------------------
create table if not exists public.artists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  bio         text,
  avatar_key  text,
  status      public.artist_status not null default 'active',
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists artists_created_by_idx on public.artists (created_by);

create table if not exists public.artist_members (
  id          uuid primary key default gen_random_uuid(),
  artist_id   uuid not null references public.artists (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (artist_id, user_id)
);
create index if not exists artist_members_user_id_idx on public.artist_members (user_id);

create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  artist_id    uuid not null references public.artists (id) on delete cascade,
  name         text not null,
  date         date,
  description  text,
  status       public.session_status not null default 'active',
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index if not exists sessions_artist_id_idx on public.sessions (artist_id);
create index if not exists sessions_created_by_idx on public.sessions (created_by);

create table if not exists public.folders (
  id          uuid primary key default gen_random_uuid(),
  artist_id   uuid not null references public.artists (id) on delete cascade,
  parent_id   uuid references public.folders (id) on delete cascade,
  name        text not null,
  kind        public.folder_kind not null default 'general',
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists folders_artist_id_idx on public.folders (artist_id);
create index if not exists folders_parent_id_idx on public.folders (parent_id);

create table if not exists public.assets (
  id                uuid primary key default gen_random_uuid(),
  kind              public.asset_kind not null,
  space             public.asset_space not null default 'workspace',
  artist_id         uuid references public.artists (id) on delete set null,
  session_id        uuid references public.sessions (id) on delete set null,
  folder_id         uuid references public.folders (id) on delete set null,
  title             text,
  original_filename text not null,
  storage_key       text not null unique,
  mime              text,
  size_bytes        bigint check (size_bytes is null or size_bytes >= 0),
  width             integer,
  height            integer,
  duration_seconds  numeric,
  status            public.asset_status not null default 'uploading',
  -- 'private': solo quien lo subió y quien tenga edit/publish; 'published': visible para quien tenga acceso.
  visibility        public.asset_visibility not null default 'private',
  downloadable      boolean not null default false,
  uploaded_by       uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index if not exists assets_artist_kind_deleted_idx on public.assets (artist_id, kind, deleted_at);
create index if not exists assets_session_id_idx on public.assets (session_id);
create index if not exists assets_folder_id_idx on public.assets (folder_id);
create index if not exists assets_uploaded_by_idx on public.assets (uploaded_by);

create table if not exists public.asset_derivatives (
  id           uuid primary key default gen_random_uuid(),
  asset_id     uuid not null references public.assets (id) on delete cascade,
  type         public.derivative_type not null,
  storage_key  text not null,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  status       public.derivative_status not null default 'pending',
  created_at   timestamptz not null default now(),
  unique (asset_id, type)
);

create table if not exists public.genres (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.beats (
  id              uuid primary key default gen_random_uuid(),
  asset_id        uuid not null references public.assets (id) on delete restrict,
  cover_asset_id  uuid references public.assets (id) on delete set null,
  title           text not null,
  bpm             integer check (bpm is null or bpm between 20 and 400),
  musical_key     text,
  genre_id        uuid references public.genres (id) on delete set null,
  status          public.beat_status not null default 'draft',
  created_on      date not null default current_date,
  downloadable    boolean not null default false,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists beats_asset_id_idx on public.beats (asset_id);
create index if not exists beats_cover_asset_id_idx on public.beats (cover_asset_id);
create index if not exists beats_genre_id_idx on public.beats (genre_id);
create index if not exists beats_created_by_idx on public.beats (created_by);

create table if not exists public.tags (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.taggings (
  id             uuid primary key default gen_random_uuid(),
  tag_id         uuid not null references public.tags (id) on delete cascade,
  resource_type  text not null check (resource_type in ('artist', 'session', 'folder', 'asset', 'beat')),
  resource_id    uuid not null,
  created_at     timestamptz not null default now(),
  unique (tag_id, resource_type, resource_id)
);
create index if not exists taggings_resource_idx on public.taggings (resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- Accesos y auditoría
-- ---------------------------------------------------------------------------
create table if not exists public.grants (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id) on delete cascade,
  resource_type  text not null check (resource_type in ('artist', 'session', 'folder', 'asset', 'beat', 'vault')),
  resource_id    uuid, -- solo es NULL para el Vault
  can_view       boolean not null default false,
  can_download   boolean not null default false,
  can_upload     boolean not null default false,
  can_edit       boolean not null default false,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint grants_vault_has_no_resource check ((resource_type = 'vault') = (resource_id is null))
);
create index if not exists grants_user_resource_idx on public.grants (user_id, resource_type, resource_id);
create index if not exists grants_created_by_idx on public.grants (created_by);
-- Un único grant vigente por usuario y recurso.
create unique index if not exists grants_one_active_per_resource
  on public.grants (user_id, resource_type, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null;

create table if not exists public.activity_log (
  id             uuid primary key default gen_random_uuid(),
  actor_id       uuid references public.profiles (id) on delete set null,
  action         text not null,
  resource_type  text,
  resource_id    uuid,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists activity_log_actor_id_idx on public.activity_log (actor_id);
create index if not exists activity_log_created_at_idx on public.activity_log (created_at desc);
create index if not exists activity_log_resource_idx on public.activity_log (resource_type, resource_id);

-- ---------------------------------------------------------------------------
-- Protecciones de integridad (valen también para el service role)
-- ---------------------------------------------------------------------------

-- Un rol bloqueado (owner) no se edita, no se borra y no cambia de permisos.
create or replace function public.protect_locked_role()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_locked then raise exception 'Un rol bloqueado no se puede eliminar' using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.is_locked or (new.is_locked and not old.is_locked) then
    raise exception 'Un rol bloqueado no se puede modificar' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger protect_locked_role
  before update or delete on public.roles
  for each row execute function public.protect_locked_role();

create or replace function public.protect_locked_role_permissions()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_role uuid := coalesce(new.role_id, old.role_id);
begin
  if exists (select 1 from public.roles where id = v_role and is_locked) then
    raise exception 'Los permisos de un rol bloqueado no se pueden modificar' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;

create trigger protect_locked_role_permissions
  before insert or update or delete on public.role_permissions
  for each row execute function public.protect_locked_role_permissions();

-- El sistema siempre conserva a su owner: no se puede borrar el perfil de un owner ACTIVO.
-- (Un owner aún sin aceptar la invitación, status 'disabled', sí puede recrearse: lo usa create-owner.)
create or replace function public.protect_owner_deletion()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status = 'active' and exists (
       select 1 from public.roles r where r.id = old.role_id and r.key = 'owner') then
    raise exception 'El owner activo no se puede eliminar' using errcode = 'P0001';
  end if;
  return old;
end $$;

drop trigger if exists protect_owner_deletion on public.profiles;
create trigger protect_owner_deletion
  before delete on public.profiles
  for each row execute function public.protect_owner_deletion();

-- El registro de actividad es de solo inserción.
create or replace function public.activity_log_append_only()
returns trigger language plpgsql set search_path = ''
as $$
begin
  raise exception 'activity_log es de solo inserción' using errcode = 'P0001';
end $$;

drop trigger if exists activity_log_append_only on public.activity_log;
create trigger activity_log_append_only
  before update or delete on public.activity_log
  for each row execute function public.activity_log_append_only();
drop trigger if exists activity_log_no_truncate on public.activity_log;
create trigger activity_log_no_truncate
  before truncate on public.activity_log
  for each statement execute function public.activity_log_append_only();

-- Registro automático de PUBLICACIONES (assets y beats), venga el cambio de donde venga.
-- Actor: el usuario de la sesión (auth.uid()) o, si la escritura la hace el servidor con el service role,
-- el valor de `app.actor_id` que la acción de servidor fija antes (select set_config('app.actor_id', uid, true)).
create or replace function public.log_publication_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := coalesce(auth.uid(), nullif(current_setting('app.actor_id', true), '')::uuid);
  v_published boolean;
  v_was_published boolean := false;
  v_type text;
begin
  if tg_table_name = 'assets' then
    v_type := 'asset';
    v_published := (new.visibility = 'published');
    if tg_op = 'UPDATE' then v_was_published := (old.visibility = 'published'); end if;
  else
    v_type := 'beat';
    v_published := (new.status = 'published');
    if tg_op = 'UPDATE' then v_was_published := (old.status = 'published'); end if;
  end if;

  if v_published is distinct from v_was_published then
    insert into public.activity_log (actor_id, action, resource_type, resource_id, metadata)
    values (v_actor, v_type || case when v_published then '.published' else '.unpublished' end, v_type, new.id, '{}'::jsonb);
  end if;
  return new;
end $$;

drop trigger if exists log_publication_assets on public.assets;
create trigger log_publication_assets
  after insert or update of visibility on public.assets
  for each row execute function public.log_publication_change();

drop trigger if exists log_publication_beats on public.beats;
create trigger log_publication_beats
  after insert or update of status on public.beats
  for each row execute function public.log_publication_change();

-- ---------------------------------------------------------------------------
-- Funciones del motor de permisos
-- ---------------------------------------------------------------------------

-- ¿Tiene el usuario ACTIVO este permiso en su rol? Un usuario solo puede consultar el suyo
-- (si hay sesión, auth.uid() debe coincidir); el service role (sin auth.uid) puede consultar a cualquiera.
create or replace function public.has_permission(p_user uuid, p_key text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case
    when auth.uid() is not null and p_user is distinct from auth.uid() then false
    else exists (
      select 1
      from public.profiles p
      join public.role_permissions rp on rp.role_id = p.role_id
      where p.id = p_user and p.status = 'active' and rp.permission_key = p_key
    )
  end
$$;

-- ¿Puede ver el listado de usuarios/invitaciones (alguna capacidad de administración)?
create or replace function public.has_admin_permission()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.role_permissions rp on rp.role_id = p.role_id
    where p.id = auth.uid() and p.status = 'active'
      and rp.permission_key in ('users.invite', 'users.manage', 'access.manage', 'roles.manage')
  )
$$;

create or replace function public.my_role_id()
returns uuid language sql stable security definer set search_path = ''
as $$
  select role_id from public.profiles where id = auth.uid() and status = 'active'
$$;

-- Carpeta y todos sus ancestros (incluida ella misma).
create or replace function public.folder_ancestors(p_folder uuid)
returns setof uuid language sql stable security definer set search_path = ''
as $$
  with recursive t as (
    select f.id, f.parent_id from public.folders f where f.id = p_folder
    union
    select f.id, f.parent_id from public.folders f join t on f.id = t.parent_id
  )
  select id from t
$$;

-- ¿El grant habilita esta acción? delete y publish dependen de can_edit.
create or replace function public.grant_allows(g public.grants, p_action text)
returns boolean language sql immutable set search_path = ''
as $$
  select case p_action
    when 'view' then g.can_view
    when 'download' then g.can_download
    when 'upload' then g.can_upload
    when 'edit' then g.can_edit
    when 'delete' then g.can_edit
    when 'publish' then g.can_edit
    else false
  end
$$;

-- ---------------------------------------------------------------------------
-- can_access: la regla de acceso. Devuelve true SOLO si se cumplen TODAS:
--  1. usuario 'active' y recurso (y su artista/sesión) no borrados
--  2. el rol tiene el permiso <área>.<acción>
--  3. alcance: scope 'all' pasa; 'assigned' exige asignación al artista del recurso o un grant vigente
--     con el flag de la acción en el recurso o en un ancestro (asset → folder(s) → session → artist)
--  4. visibilidad: sin *.edit ni *.publish solo ve assets 'published' o los que subió él
--  5. Vault: además exige grant explícito de tipo 'vault' (el owner siempre pasa); no hereda de artistas/sesiones
--  6. download exige downloadable = true en el asset o beat
-- El rol es el techo: un grant nunca concede lo que el rol no permite (el paso 2 va primero).
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
  -- Solo se puede consultar el acceso propio (el service role, sin auth.uid(), puede consultar a cualquiera).
  if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;
  if p_user is null or p_action is null
     or p_action not in ('view', 'download', 'upload', 'edit', 'delete', 'publish') then
    return false;
  end if;

  -- 1) usuario activo
  select p.role_id, r.key, r.scope into v_role_id, v_role_key, v_scope
  from public.profiles p join public.roles r on r.id = p.role_id
  where p.id = p_user and p.status = 'active';
  if not found then return false; end if;

  -- Resolución del recurso (y comprobación de borrado)
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
    v_area := case when f.kind = 'photos' then 'photos' when f.kind = 'videos' then 'videos' else 'files' end;

  else
    return false; -- tipo desconocido: denegar
  end if;

  -- 2) el rol tiene el permiso
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

  -- 5) Vault: grant explícito de tipo 'vault' (no hereda de artistas ni sesiones); el owner siempre pasa.
  if v_is_vault then
    if v_role_key <> 'owner' and not exists (
      select 1 from public.grants g
      where g.user_id = p_user and g.resource_type = 'vault' and g.revoked_at is null
        and (g.expires_at is null or g.expires_at > now())
        and public.grant_allows(g, p_action)
    ) then return false; end if;
  else
    -- 3) alcance
    if v_scope = 'assigned' then
      if not (
        (v_artist is not null and exists (
           select 1 from public.artist_members m where m.artist_id = v_artist and m.user_id = p_user))
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

  -- 4) visibilidad (assets y beats)
  if v_visibility is not null and v_visibility <> 'published' and v_uploaded_by is distinct from p_user then
    if not exists (
      select 1 from public.role_permissions
      where role_id = v_role_id and permission_key in (v_area || '.edit', v_area || '.publish')
    ) then return false; end if;
  end if;

  -- 6) descargas
  if p_action = 'download' and v_downloadable is not null and not v_downloadable then
    return false;
  end if;

  return true;
end
$$;

-- Reemplaza de forma atómica los permisos de un rol (solo service role; el trigger protege el owner).
create or replace function public.replace_role_permissions(p_role uuid, p_keys text[])
returns void language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.role_permissions where role_id = p_role;
  insert into public.role_permissions (role_id, permission_key)
  select p_role, k from (select distinct unnest(p_keys) as k) x;
end $$;

-- ---------------------------------------------------------------------------
-- Privilegios
-- ---------------------------------------------------------------------------
revoke all on
  public.permissions, public.role_permissions, public.artists, public.artist_members, public.sessions,
  public.folders, public.assets, public.asset_derivatives, public.genres, public.beats, public.tags,
  public.taggings, public.grants, public.activity_log
from anon, authenticated;

grant select on
  public.permissions, public.role_permissions, public.artists, public.artist_members, public.sessions,
  public.folders, public.assets, public.asset_derivatives, public.genres, public.beats, public.tags,
  public.taggings, public.grants, public.activity_log
to authenticated;

revoke execute on function
  public.has_permission(uuid, text), public.has_admin_permission(), public.my_role_id(),
  public.folder_ancestors(uuid), public.grant_allows(public.grants, text),
  public.can_access(uuid, text, text, uuid), public.replace_role_permissions(uuid, text[]),
  public.protect_locked_role(), public.protect_locked_role_permissions(), public.protect_owner_deletion(),
  public.activity_log_append_only(), public.log_publication_change()
from public, anon, authenticated;

grant execute on function
  public.has_permission(uuid, text), public.has_admin_permission(), public.my_role_id(),
  public.can_access(uuid, text, text, uuid)
to authenticated;

-- El servidor (service role) evalúa permisos de cualquier usuario y reemplaza permisos de roles.
grant execute on function
  public.has_permission(uuid, text), public.can_access(uuid, text, text, uuid),
  public.replace_role_permissions(uuid, text[])
to service_role;

-- ---------------------------------------------------------------------------
-- RLS: activada en todo; solo lectura, siempre a través de la regla de acceso
-- ---------------------------------------------------------------------------
alter table public.permissions       enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.artists           enable row level security;
alter table public.artist_members    enable row level security;
alter table public.sessions          enable row level security;
alter table public.folders           enable row level security;
alter table public.assets            enable row level security;
alter table public.asset_derivatives enable row level security;
alter table public.genres            enable row level security;
alter table public.beats             enable row level security;
alter table public.tags              enable row level security;
alter table public.taggings          enable row level security;
alter table public.grants            enable row level security;
alter table public.activity_log      enable row level security;

-- Fase 1: el listado de usuarios e invitaciones lo ve quien tenga alguna capacidad de administración
-- (antes estaba fijado a owner/admin; ahora depende de los permisos del rol).
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin
  on public.profiles for select to authenticated
  using (public.has_admin_permission());

drop policy if exists invitations_select_admin on public.invitations;
create policy invitations_select_admin
  on public.invitations for select to authenticated
  using (public.has_admin_permission());

-- Catálogo y permisos de roles
drop policy if exists permissions_select_active on public.permissions;
create policy permissions_select_active
  on public.permissions for select to authenticated
  using (public.current_role_key() is not null);

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select
  on public.role_permissions for select to authenticated
  using (role_id = public.my_role_id() or public.has_permission((select auth.uid()), 'roles.manage'));

-- Contenido: solo lo que can_access('view') permite
drop policy if exists artists_select on public.artists;
create policy artists_select on public.artists for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'artist', id));

drop policy if exists sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'session', id));

drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'folder', id));

drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'asset', id));

drop policy if exists asset_derivatives_select on public.asset_derivatives;
create policy asset_derivatives_select on public.asset_derivatives for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'asset', asset_id));

drop policy if exists beats_select on public.beats;
create policy beats_select on public.beats for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'beat', id));

drop policy if exists genres_select on public.genres;
create policy genres_select on public.genres for select to authenticated
  using (public.has_permission((select auth.uid()), 'beats.view'));

drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags for select to authenticated
  using (public.current_role_key() is not null);

drop policy if exists taggings_select on public.taggings;
create policy taggings_select on public.taggings for select to authenticated
  using (public.can_access((select auth.uid()), 'view', resource_type, resource_id));

-- Asignaciones y grants: los propios, o todos para quien gestiona accesos
drop policy if exists artist_members_select on public.artist_members;
create policy artist_members_select on public.artist_members for select to authenticated
  using (user_id = (select auth.uid()) or public.has_permission((select auth.uid()), 'access.manage'));

drop policy if exists grants_select on public.grants;
create policy grants_select on public.grants for select to authenticated
  using (user_id = (select auth.uid()) or public.has_permission((select auth.uid()), 'access.manage'));

-- Auditoría: solo la lee quien gestiona accesos. Sin políticas de insert/update/delete.
drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.has_permission((select auth.uid()), 'access.manage'));
