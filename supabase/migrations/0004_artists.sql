-- MLS Drive — Fase 4: espacios por artista (carpetas, publicación y acceso)
--
-- REAPLICABLE (idempotente). NO modifica la regla de acceso `can_access` de la Fase 2: solo añade el
-- permiso `artists.manage` al catálogo, columnas, carpetas base, resúmenes y los índices de listado.
--
-- Recordatorio de diseño: `assets.storage_key` es un identificador OPACO e INMUTABLE. Mover un archivo
-- entre carpetas o artistas solo cambia filas de la base de datos; jamás se renombra un objeto en R2.

-- ---------------------------------------------------------------------------
-- Permiso artists.manage (crear y archivar artistas)
-- ---------------------------------------------------------------------------
alter table public.permissions drop constraint if exists permissions_area_check;
alter table public.permissions add constraint permissions_area_check
  check (area in ('photos','videos','files','beats','vault','users','access','roles','artists'));

-- Solo la primera vez: se concede a owner y admin por defecto (volver a aplicar no pisa ediciones de roles).
do $$
begin
  if not exists (select 1 from public.permissions where key = 'artists.manage') then
    insert into public.permissions (key, area, action, description)
    values ('artists.manage', 'artists', 'manage', 'Gestionar artistas (crear, editar y archivar)');

    -- El owner es un rol bloqueado: su trigger de protección se salta solo durante esta siembra.
    drop trigger if exists protect_locked_role_permissions on public.role_permissions;
    insert into public.role_permissions (role_id, permission_key)
    select r.id, 'artists.manage' from public.roles r where r.key in ('owner', 'admin')
    on conflict (role_id, permission_key) do nothing;
    create trigger protect_locked_role_permissions
      before insert or update or delete on public.role_permissions
      for each row execute function public.protect_locked_role_permissions();
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- artists: avatar como asset (se abandona avatar_key)
-- ---------------------------------------------------------------------------
alter table public.artists
  add column if not exists avatar_asset_id uuid references public.assets (id) on delete set null;
alter table public.artists drop column if exists avatar_key;
create index if not exists artists_avatar_asset_id_idx on public.artists (avatar_asset_id);
create index if not exists artists_status_idx on public.artists (status) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- folders: borrado lógico y nombre único por (artista, carpeta madre) entre las no borradas
-- ---------------------------------------------------------------------------
alter table public.folders add column if not exists deleted_at timestamptz;

create unique index if not exists folders_unique_name_per_parent
  on public.folders (artist_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where deleted_at is null;

-- Las carpetas borradas no se ven (la regla can_access no cambia: se filtra aquí)
drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders for select to authenticated
  using (public.can_access((select auth.uid()), 'view', 'folder', id) and deleted_at is null);

-- ---------------------------------------------------------------------------
-- Carpetas base de cada artista: Fotos, Vídeos y Archivos
-- ---------------------------------------------------------------------------
create or replace function public.create_artist_defaults(p_artist uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.folders (artist_id, parent_id, name, kind, sort)
  select p_artist, null, v.name, v.kind::public.folder_kind, v.sort
  from (values ('Fotos', 'photos', 0), ('Vídeos', 'videos', 1), ('Archivos', 'files', 2)) as v(name, kind, sort)
  where not exists (
    select 1 from public.folders f
    where f.artist_id = p_artist and f.parent_id is null and lower(f.name) = lower(v.name) and f.deleted_at is null
  );
end $$;

-- Se llama al crear un artista (desde cualquier vía: acción de servidor, script de ejemplo…)
create or replace function public.artists_after_insert()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform public.create_artist_defaults(new.id);
  return new;
end $$;

drop trigger if exists artists_create_defaults on public.artists;
create trigger artists_create_defaults
  after insert on public.artists
  for each row execute function public.artists_after_insert();

-- Artistas que ya existían
select public.create_artist_defaults(id) from public.artists;

-- ---------------------------------------------------------------------------
-- Índices de listado paginado (cursor por created_at, id)
-- ---------------------------------------------------------------------------
create index if not exists assets_artist_folder_created_idx
  on public.assets (artist_id, folder_id, created_at desc, id desc) where deleted_at is null;
-- «Todo» del artista (sin filtrar por tipo ni carpeta): lo último subido
create index if not exists assets_artist_created_idx
  on public.assets (artist_id, created_at desc, id desc) where deleted_at is null;
create index if not exists assets_artist_kind_created_idx
  on public.assets (artist_id, kind, created_at desc, id desc) where deleted_at is null;
create index if not exists activity_log_resource_created_idx
  on public.activity_log (resource_type, resource_id, created_at desc, id desc);
-- El índice nuevo cubre al anterior (mismo prefijo): se elimina el redundante.
drop index if exists public.activity_log_resource_idx;

-- ---------------------------------------------------------------------------
-- Resúmenes (SECURITY INVOKER: cada usuario cuenta SOLO lo que RLS le deja ver).
-- El avatar del artista es un asset propio de su ficha: no cuenta como foto ni como pendiente.
-- ---------------------------------------------------------------------------
create or replace function public.artist_summary(p_artist uuid)
returns table (
  artist_id uuid, sessions bigint, photos bigint, videos bigint, files bigint,
  beats_shared bigint, members bigint, pending bigint
)
language sql stable security invoker set search_path = ''
as $$
  select
    p_artist,
    (select count(*) from public.sessions s where s.artist_id = p_artist and s.deleted_at is null),
    (select count(*) from public.assets a where a.artist_id = p_artist and a.deleted_at is null and a.status = 'ready' and a.id is distinct from (select x.avatar_asset_id from public.artists x where x.id = p_artist) and a.kind = 'photo'),
    (select count(*) from public.assets a where a.artist_id = p_artist and a.deleted_at is null and a.status = 'ready' and a.id is distinct from (select x.avatar_asset_id from public.artists x where x.id = p_artist) and a.kind = 'video'),
    (select count(*) from public.assets a where a.artist_id = p_artist and a.deleted_at is null and a.status = 'ready' and a.id is distinct from (select x.avatar_asset_id from public.artists x where x.id = p_artist) and a.kind in ('document', 'audio', 'other')),
    -- beats compartidos: beats con un acceso vigente para alguien de este artista
    (select count(distinct g.resource_id) from public.grants g
       join public.artist_members m on m.user_id = g.user_id and m.artist_id = p_artist
      where g.resource_type = 'beat' and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())),
    -- personas con acceso: asignadas al artista o con un acceso vigente sobre él
    (select count(*) from (
       select m.user_id from public.artist_members m where m.artist_id = p_artist
       union
       select g.user_id from public.grants g
        where g.resource_type = 'artist' and g.resource_id = p_artist and g.revoked_at is null
          and (g.expires_at is null or g.expires_at > now())
     ) people),
    -- pendientes de publicar: subidos y listos, aún privados
    (select count(*) from public.assets a where a.artist_id = p_artist and a.deleted_at is null and a.status = 'ready' and a.id is distinct from (select x.avatar_asset_id from public.artists x where x.id = p_artist) and a.visibility = 'private')
$$;

create or replace function public.artist_summaries()
returns table (
  artist_id uuid, sessions bigint, photos bigint, videos bigint, files bigint,
  beats_shared bigint, members bigint, pending bigint
)
language sql stable security invoker set search_path = ''
as $$
  select s.* from public.artists a
  cross join lateral public.artist_summary(a.id) s
  where a.deleted_at is null
$$;

-- Elementos por carpeta de un artista (los que el usuario puede ver)
create or replace function public.folder_counts(p_artist uuid)
returns table (folder_id uuid, items bigint)
language sql stable security invoker set search_path = ''
as $$
  select a.folder_id, count(*)::bigint
  from public.assets a
  where a.artist_id = p_artist and a.deleted_at is null and a.status = 'ready' and a.folder_id is not null
  group by a.folder_id
$$;

-- Historial del artista (subidas, publicaciones, descargas y cambios de acceso), paginado por cursor.
-- Solo para quien gestiona accesos (la auditoría es de administración). Excluye el ruido de upload.init.
create or replace function public.artist_activity(
  p_artist uuid, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 30
)
returns table (
  id uuid, actor_id uuid, action text, resource_type text, resource_id uuid, metadata jsonb, created_at timestamptz
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.has_permission(auth.uid(), 'access.manage') then
    return;
  end if;
  return query
  select l.id, l.actor_id, l.action, l.resource_type, l.resource_id, l.metadata, l.created_at
  from public.activity_log l
  where l.action <> 'upload.init'
    and (
      (l.resource_type = 'artist' and l.resource_id = p_artist)
      or (l.resource_type = 'asset' and l.resource_id in (select a.id from public.assets a where a.artist_id = p_artist))
    )
    and (p_before_at is null or (l.created_at, l.id) < (p_before_at, p_before_id))
  order by l.created_at desc, l.id desc
  limit least(greatest(p_limit, 1), 100);
end $$;

revoke execute on function
  public.create_artist_defaults(uuid), public.artists_after_insert(),
  public.artist_summary(uuid), public.artist_summaries(), public.folder_counts(uuid),
  public.artist_activity(uuid, timestamptz, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.artist_summary(uuid), public.artist_summaries(), public.folder_counts(uuid),
  public.artist_activity(uuid, timestamptz, uuid, integer)
to authenticated;

grant execute on function public.create_artist_defaults(uuid) to service_role;
