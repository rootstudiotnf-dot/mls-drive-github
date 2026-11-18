-- MLS Drive — Fase 3: almacenamiento (R2), subidas y ficha de archivo
--
-- REAPLICABLE (idempotente). No modifica la regla de acceso de la Fase 2 (`can_access`): solo añade
-- columnas de seguimiento de subida, índices, una función para publicar con autor y otra de uso de
-- almacenamiento, y una condición de ESTADO en la política de lectura de assets (los assets
-- 'uploading' o 'failed' solo los ve quien los subió: «los assets fallidos no son visibles»).

-- ---------------------------------------------------------------------------
-- Seguimiento de la subida (solo servidor: nunca viajan al cliente como claves)
-- ---------------------------------------------------------------------------
alter table public.assets
  add column if not exists upload_id text,               -- id del multipart en R2 (nulo en subidas simples)
  add column if not exists part_size_bytes integer;      -- tamaño de parte acordado para ese multipart

-- Límite de subidas simultáneas por usuario y barrido de abandonadas
create index if not exists assets_uploading_by_user_idx
  on public.assets (uploaded_by) where status = 'uploading' and deleted_at is null;
create index if not exists assets_stale_upload_idx
  on public.assets (created_at) where status in ('uploading', 'failed');
-- Papelera: purga por antigüedad
create index if not exists assets_trash_idx
  on public.assets (deleted_at) where deleted_at is not null;
-- Límite de 500 initUpload por hora (se cuenta desde activity_log)
create index if not exists activity_log_actor_action_idx
  on public.activity_log (actor_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Visibilidad de assets según su estado de subida
--   'ready'           → lo ve quien tenga acceso (can_access)
--   'uploading/failed' → solo quien lo subió (para reanudar o reintentar)
-- ---------------------------------------------------------------------------
drop policy if exists assets_select on public.assets;
create policy assets_select on public.assets for select to authenticated
  using (
    public.can_access((select auth.uid()), 'view', 'asset', id)
    and (status = 'ready' or uploaded_by = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Cambiar la visibilidad CON AUTOR: fija el actor en la misma transacción para que el trigger de
-- publicación (log_publication_change) lo registre. Solo la llama el servidor (service role).
-- ---------------------------------------------------------------------------
create or replace function public.set_asset_visibility(
  p_asset uuid, p_visibility public.asset_visibility, p_actor uuid
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform set_config('app.actor_id', coalesce(p_actor::text, ''), true);
  update public.assets set visibility = p_visibility where id = p_asset;
end $$;

-- ---------------------------------------------------------------------------
-- Uso de almacenamiento (para /almacenamiento): bytes y archivos por tipo y artista.
-- Cuenta assets 'ready' no borrados y, aparte, los derivados (miniaturas/web).
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
  select 'derivatives', null::uuid, count(*)::bigint, coalesce(sum(d.size_bytes), 0)::bigint
  from public.asset_derivatives d
  join public.assets a on a.id = d.asset_id
  where d.status = 'ready' and a.deleted_at is null
$$;

revoke execute on function
  public.set_asset_visibility(uuid, public.asset_visibility, uuid), public.storage_usage()
from public, anon, authenticated;
grant execute on function
  public.set_asset_visibility(uuid, public.asset_visibility, uuid), public.storage_usage()
to service_role;
