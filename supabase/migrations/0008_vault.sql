-- MLS Drive — Fase 8: Private Vault
--
-- Idempotente (reaplicable). Aplicar DESPUÉS de 0001–0007.
--
--  1. folders.space ('workspace' | 'vault'); carpetas base del Vault (sin artista).
--  2. Coherencia assets ⇄ carpetas del Vault (un asset del Vault vive en una carpeta del Vault y no en una sesión).
--  3. grants: el acceso al Vault caduca SIEMPRE (obligatorio, máximo 90 días); también los de carpetas del Vault.
--  4. can_access para el Vault: usuario activo + permiso vault.<acción> + grant vigente (Vault o carpeta) + aal2.
--  5. RLS: el Vault no existe para ninguna consulta normal (assets, carpetas, actividad).
--  6. Funciones de definer que veían todo (actividad por artista, uso de almacenamiento) excluyen el Vault.
--  7. activity_log: prefijo `vault.` reservado (12 acciones); solo lo lee quien lo consulta desde el servidor.
--  8. Tablas de servicio: intentos de desbloqueo, códigos de recuperación MFA, objetos huérfanos por mover.

-- ---------------------------------------------------------------------------
-- 1. folders.space
-- ---------------------------------------------------------------------------
alter table public.folders add column if not exists space public.asset_space not null default 'workspace';
alter table public.folders alter column artist_id drop not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'folders_space_artist_check') then
    alter table public.folders add constraint folders_space_artist_check
      check ((space = 'vault') = (artist_id is null));
  end if;
end $$;

create unique index if not exists folders_vault_unique_name
  on public.folders (lower(name))
  where space = 'vault' and deleted_at is null and parent_id is null;
create index if not exists folders_space_idx on public.folders (space) where space = 'vault';

-- Carpetas base del Vault (sin artista)
insert into public.folders (name, kind, sort, space, artist_id)
select v.name, 'general', v.sort, 'vault', null
from (values
  ('Vídeos originales', 0), ('BTS', 1), ('Tomas descartadas', 2),
  ('Fotos RAW', 3), ('Archivos de proyecto', 4), ('Documentos', 5)
) as v(name, sort)
where not exists (
  select 1 from public.folders f
  where f.space = 'vault' and lower(f.name) = lower(v.name) and f.parent_id is null and f.deleted_at is null
);

-- ---------------------------------------------------------------------------
-- 2. Coherencia assets ⇄ carpetas
-- ---------------------------------------------------------------------------
create or replace function public.assets_vault_consistency()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare v_folder_space public.asset_space;
begin
  if new.folder_id is not null then
    select f.space into v_folder_space from public.folders f where f.id = new.folder_id;
  end if;
  if new.space = 'vault' then
    if new.session_id is not null then
      raise exception 'Un archivo del Vault no puede pertenecer a una sesión' using errcode = 'P0001';
    end if;
    if new.folder_id is null or v_folder_space is distinct from 'vault' then
      raise exception 'Un archivo del Vault debe estar en una carpeta del Vault' using errcode = 'P0001';
    end if;
  elsif v_folder_space = 'vault' then
    raise exception 'Una carpeta del Vault solo admite archivos del Vault' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists assets_vault_consistency on public.assets;
create trigger assets_vault_consistency before insert or update of space, folder_id, session_id on public.assets
  for each row execute function public.assets_vault_consistency();

-- ---------------------------------------------------------------------------
-- 3. grants del Vault: caducidad obligatoria (máx. 90 días desde su creación)
-- ---------------------------------------------------------------------------
update public.grants set expires_at = created_at + interval '30 days'
where resource_type = 'vault' and expires_at is null;
update public.grants set expires_at = created_at + interval '90 days'
where resource_type = 'vault' and expires_at > created_at + interval '90 days';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grants_vault_expiry_check') then
    alter table public.grants add constraint grants_vault_expiry_check
      check (resource_type <> 'vault' or (expires_at is not null and expires_at <= created_at + interval '90 days'));
  end if;
end $$;

-- Un grant de tipo 'folder' sobre una carpeta del Vault sigue la misma regla
create or replace function public.grants_vault_folder_rules()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.resource_type = 'folder' and exists (select 1 from public.folders f where f.id = new.resource_id and f.space = 'vault') then
    if new.expires_at is null or new.expires_at > new.created_at + interval '90 days' then
      raise exception 'El acceso a una carpeta del Vault debe caducar (máximo 90 días)' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists grants_vault_folder_rules on public.grants;
create trigger grants_vault_folder_rules before insert or update of expires_at, resource_id, resource_type on public.grants
  for each row execute function public.grants_vault_folder_rules();

-- ---------------------------------------------------------------------------
-- 4. can_access con el Vault (cambios marcados con «Fase 8»)
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
  v_beat_of uuid;
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
    -- Fase 7: el audio de un beat se autoriza A TRAVÉS del beat (estado, compartido, descarga en tres capas)
    if a.kind = 'audio' then
      select bb.id into v_beat_of from public.beats bb where bb.asset_id = a.id and bb.deleted_at is null limit 1;
      if v_beat_of is not null then
        return public.can_access(p_user, p_action, 'beat', v_beat_of);
      end if;
    end if;
    -- Fase 7: la portada de un beat se ve si se puede ver el beat (además de las reglas normales)
    if a.kind = 'photo' and p_action = 'view' and a.artist_id is null then
      if exists (select 1 from public.beats bb where bb.cover_asset_id = a.id and bb.deleted_at is null
                 and public.can_access(p_user, 'view', 'beat', bb.id)) then
        return true;
      end if;
    end if;
    v_is_vault := (a.space = 'vault');
    if not v_is_vault then
      if a.artist_id is not null and exists (
           select 1 from public.artists x where x.id = a.artist_id and x.deleted_at is not null) then return false; end if;
      if a.session_id is not null and exists (
           select 1 from public.sessions x where x.id = a.session_id and x.deleted_at is not null) then return false; end if;
    end if;
    v_asset := a.id; v_folder := a.folder_id;
    v_area := case when v_is_vault then 'vault'
                   when a.kind = 'photo' then 'photos'
                   when a.kind = 'video' then 'videos'
                   else 'files' end;
    if not v_is_vault then
      v_artist := a.artist_id; v_session := a.session_id;
      v_visibility := a.visibility::text; v_uploaded_by := a.uploaded_by; v_downloadable := a.downloadable;
    end if;
    -- Fase 8: en el Vault el artista (si lo hay) es solo informativo: no da acceso; la visibilidad y
    -- `downloadable` del espacio normal no cuentan.

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
    if f.space = 'vault' then
      -- Fase 8: una carpeta del Vault se rige SOLO por el Vault
      if f.deleted_at is not null then return false; end if;
      v_is_vault := true; v_area := 'vault'; v_folder := f.id;
    else
      if exists (select 1 from public.artists x where x.id = f.artist_id and x.deleted_at is not null) then
        return false;
      end if;
      v_folder := f.id; v_artist := f.artist_id;
      v_session := f.session_id; -- Fase 5: una carpeta de sesión hereda el acceso de la sesión
      v_area := case when f.kind = 'photos' then 'photos' when f.kind = 'videos' then 'videos' else 'files' end;
    end if;

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
    -- Fase 8: con un JWT de usuario (RLS / cliente del usuario) la sesión debe ser aal2 (TOTP verificado).
    -- Cuando el servidor llama con el service role no hay JWT de usuario: el servidor exige aal2 y el
    -- desbloqueo del Vault por su cuenta (lib/vault/access.ts) y falla cerrado si no puede comprobarlo.
    if auth.uid() is not null
       and coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'aal', '') <> 'aal2' then
      return false;
    end if;
    -- El owner pasa el grant; todos los demás necesitan un grant VIGENTE (con caducidad obligatoria) del
    -- Vault entero o de la carpeta concreta (o su carpeta madre) con el flag de la acción.
    if v_role_key <> 'owner' and not exists (
      select 1 from public.grants g
      where g.user_id = p_user and g.revoked_at is null
        and g.expires_at is not null and g.expires_at > now()
        and public.grant_allows(g, p_action)
        and (
          g.resource_type = 'vault'
          or (g.resource_type = 'folder' and v_folder is not null
              and g.resource_id in (select public.folder_ancestors(v_folder)))
        )
    ) then return false; end if;
  else
    if v_scope = 'assigned' then
      if not (
        (v_artist is not null and exists (
           select 1 from public.artist_members m where m.artist_id = v_artist and m.user_id = p_user))
        -- Fase 7: beat compartido con un artista al que pertenece la persona
        or (v_beat is not null and exists (
           select 1 from public.beat_artists ba
           join public.artist_members m on m.artist_id = ba.artist_id and m.user_id = p_user
           where ba.beat_id = v_beat))
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

  -- Fase 7: descargar el ORIGINAL de un beat exige además (salvo alcance «all») que el artista que lo recibe
  -- tenga can_download o que haya un grant vigente con descarga sobre el beat
  if p_action = 'download' and v_beat is not null and v_scope <> 'all' then
    if not (
      exists (select 1 from public.beat_artists ba
              join public.artist_members m on m.artist_id = ba.artist_id and m.user_id = p_user
              where ba.beat_id = v_beat and ba.can_download)
      or exists (select 1 from public.grants g
                 where g.user_id = p_user and g.revoked_at is null and g.resource_type = 'beat' and g.resource_id = v_beat
                   and (g.expires_at is null or g.expires_at > now()) and g.can_download)
    ) then return false; end if;
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

-- Comentarios: nunca sobre archivos del Vault
create or replace function public.can_comment(p_user uuid, p_asset uuid)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  v_kind public.asset_kind;
  v_space public.asset_space;
  v_area text;
begin
  select kind, space into v_kind, v_space from public.assets where id = p_asset and deleted_at is null;
  if not found or v_space = 'vault' then return false; end if;
  v_area := case when v_kind = 'photo' then 'photos' when v_kind = 'video' then 'videos' when v_kind = 'audio' then 'beats' else null end;
  if v_area is null then return false; end if;
  return public.can_access(p_user, 'view', 'asset', p_asset) and public.has_permission(p_user, v_area || '.comment');
end $$;
revoke execute on function public.can_comment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.can_comment(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RLS: ninguna consulta normal ve el Vault (el Vault se lee SOLO desde el servidor, tras desbloquear)
-- ---------------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated
  using (
    space = 'workspace'
    and public.can_access((select auth.uid()), 'view', 'asset', id)
    and (status = 'ready' or uploaded_by = (select auth.uid()))
  );

drop policy if exists folders_select on public.folders;
create policy folders_select on public.folders for select to authenticated
  using (space = 'workspace' and public.can_access((select auth.uid()), 'view', 'folder', id) and deleted_at is null);

-- ---------------------------------------------------------------------------
-- 7. activity_log: prefijo `vault.` reservado; quien gestiona accesos NO lee el registro del Vault
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'activity_log_vault_actions_check') then
    alter table public.activity_log add constraint activity_log_vault_actions_check
      check (action not like 'vault.%' or action in (
        'vault.open', 'vault.list', 'vault.preview', 'vault.download', 'vault.upload', 'vault.move_in',
        'vault.move_out', 'vault.trash', 'vault.restore', 'vault.delete', 'vault.grant', 'vault.revoke'));
  end if;
end $$;
create index if not exists activity_log_vault_idx on public.activity_log (created_at desc, id desc) where action like 'vault.%';
create index if not exists activity_log_actor_action_created_idx on public.activity_log (actor_id, action, created_at desc);

drop policy if exists activity_log_select on public.activity_log;
create policy activity_log_select on public.activity_log for select to authenticated
  using (public.has_permission((select auth.uid()), 'access.manage') and action not like 'vault.%');

-- ---------------------------------------------------------------------------
-- 6. Funciones de definer que no pasan por RLS
-- ---------------------------------------------------------------------------
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
  where l.action <> 'upload.init' and l.action not like 'vault.%'
    and (
      (l.resource_type = 'artist' and l.resource_id = p_artist)
      or (l.resource_type = 'asset' and l.resource_id in (select a.id from public.assets a where a.artist_id = p_artist and a.space = 'workspace'))
    )
    and (p_before_at is null or (l.created_at, l.id) < (p_before_at, p_before_id))
  order by l.created_at desc, l.id desc
  limit least(greatest(p_limit, 1), 100);
end $$;

-- Uso de almacenamiento: el Vault es una línea aparte (kind 'vault'), fuera del desglose por artista
create or replace function public.storage_usage()
returns table (kind text, artist_id uuid, files bigint, bytes bigint)
language sql stable security definer set search_path = ''
as $$
  select a.kind::text, a.artist_id, count(*)::bigint, coalesce(sum(a.size_bytes), 0)::bigint
  from public.assets a
  where a.status = 'ready' and a.deleted_at is null and a.space = 'workspace'
  group by a.kind, a.artist_id
  union all
  select 'vault', null::uuid, count(*)::bigint, coalesce(sum(a.size_bytes), 0)::bigint
  from public.assets a
  where a.status = 'ready' and a.deleted_at is null and a.space = 'vault'
  union all
  select 'derivative:' || d.type::text, null::uuid, count(*)::bigint, coalesce(sum(d.size_bytes), 0)::bigint
  from public.asset_derivatives d
  join public.assets a on a.id = d.asset_id
  where d.status = 'ready' and a.deleted_at is null and a.space = 'workspace'
  group by d.type
$$;
revoke execute on function public.storage_usage() from public, anon, authenticated;
grant execute on function public.storage_usage() to service_role;
revoke execute on function public.artist_activity(uuid, timestamptz, uuid, integer) from public, anon;
grant execute on function public.artist_activity(uuid, timestamptz, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Tablas de servicio (solo service role: RLS activada y sin políticas)
-- ---------------------------------------------------------------------------
-- Desbloqueo del Vault: 5 fallos seguidos → bloqueo de 15 minutos
create table if not exists public.vault_unlock_attempts (
  user_id      uuid primary key references public.profiles (id) on delete cascade,
  failures     integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

-- Códigos de recuperación MFA: solo su hash (SHA-256 con sal por código); se muestran una vez
create table if not exists public.mfa_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  salt       text not null,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mfa_recovery_codes_user_idx on public.mfa_recovery_codes (user_id) where used_at is null;

-- Objetos que quedaron en un bucket tras mover un archivo entre buckets (se borran con el script de purga)
create table if not exists public.storage_orphans (
  id         uuid primary key default gen_random_uuid(),
  bucket     text not null check (bucket in ('main', 'vault')),
  object_key text not null,
  asset_id   uuid,
  attempts   integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.vault_unlock_attempts enable row level security;
alter table public.mfa_recovery_codes enable row level security;
alter table public.storage_orphans enable row level security;
revoke all on public.vault_unlock_attempts, public.mfa_recovery_codes, public.storage_orphans from anon, authenticated;
grant select, insert, update, delete on public.vault_unlock_attempts, public.mfa_recovery_codes, public.storage_orphans to service_role;

revoke execute on function
  public.assets_vault_consistency(), public.grants_vault_folder_rules()
from public, anon, authenticated;

-- Movimientos de archivos entre buckets en curso (la copia la hace el navegador con URLs prefirmadas; el servidor
-- solo autoriza, firma y verifica). La fila desaparece al completar o abortar; las que quedan huérfanas las limpia
-- scripts/purge-trash.ts.
create table if not exists public.vault_moves (
  asset_id       uuid primary key references public.assets (id) on delete cascade,
  direction      text not null check (direction in ('in', 'out')),
  dest_key       text not null,
  upload_id      text,
  part_size      bigint,
  dest_folder_id uuid,
  dest_artist_id uuid,
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
alter table public.vault_moves enable row level security;
revoke all on public.vault_moves from anon, authenticated;
grant select, insert, update, delete on public.vault_moves to service_role;
