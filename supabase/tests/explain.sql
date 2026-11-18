-- MLS Drive — comprobación de índices con EXPLAIN (Fase 2)
--
-- Genera datos sintéticos (20 000 assets, 200 artistas) dentro de una transacción, ejecuta ANALYZE y
-- comprueba con EXPLAIN que las consultas habituales USAN ÍNDICE y no recorren toda la tabla.
-- Termina en ROLLBACK (no deja datos). Si una consulta usa Seq Scan, el script falla.
-- Aplícalo después de 0001 y 0002.

begin;

-- Datos de relleno (solo para medir planes)
insert into public.artists (id, name, slug)
select ('a0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'Artista ' || i, 'artista-' || i
from generate_series(1, 200) i;

insert into public.sessions (id, artist_id, name)
select ('b0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       ('a0000000-0000-0000-0000-' || lpad(((i - 1) % 200 + 1)::text, 12, '0'))::uuid, 'Sesión ' || i
from generate_series(1, 1000) i;

insert into public.assets (kind, artist_id, session_id, original_filename, storage_key, visibility, downloadable)
select (array['photo','video','document','audio','other'])[1 + (i % 5)]::public.asset_kind,
       ('a0000000-0000-0000-0000-' || lpad(((i - 1) % 200 + 1)::text, 12, '0'))::uuid,
       ('b0000000-0000-0000-0000-' || lpad(((i - 1) % 1000 + 1)::text, 12, '0'))::uuid,
       'f' || i || '.bin', 'k-' || i, 'published', true
from generate_series(1, 20000) i;

-- Fase 4: un artista con 500 assets, 450 de ellos en una carpeta (listados paginados por cursor)
insert into public.assets (kind, artist_id, folder_id, original_filename, storage_key, visibility, downloadable, status, created_at)
select (array['photo','video','document'])[1 + (i % 3)]::public.asset_kind,
       'a0000000-0000-0000-0000-000000000007'::uuid,
       case when i <= 450 then (select id from public.folders where artist_id = 'a0000000-0000-0000-0000-000000000007' and kind = 'photos' and parent_id is null) end,
       'g' || i || '.bin', 'kg-' || i, 'published', true, 'ready', now() - (i || ' minutes')::interval
from generate_series(1, 500) i;

analyze public.assets;
analyze public.folders;
analyze public.sessions;
analyze public.artists;

create function pg_temp.plan_of(q text) returns text language plpgsql as $$
declare r text; out text := '';
begin
  for r in execute 'explain (costs off) ' || q loop out := out || r || E'\n'; end loop;
  return out;
end $$;

do $$
declare
  p text;
begin
  -- 1) Assets de un artista por tipo, sin borrados (índice assets_artist_kind_deleted_idx)
  p := pg_temp.plan_of($q$
    select id from public.assets
    where artist_id = 'a0000000-0000-0000-0000-000000000007' and kind = 'photo' and deleted_at is null $q$);
  raise notice E'assets por artista+tipo:\n%', p;
  assert p like '%assets_artist_kind_deleted_idx%' and p not like '%Seq Scan%',
    'assets(artist_id, kind, deleted_at): la consulta debe usar el índice';

  -- 2) Assets de una sesión (índice assets_session_id_idx)
  p := pg_temp.plan_of($q$
    select id from public.assets where session_id = 'b0000000-0000-0000-0000-000000000042' $q$);
  raise notice E'assets por sesión:\n%', p;
  assert p like '%assets_session_id_idx%' and p not like '%Seq Scan%',
    'assets(session_id): la consulta debe usar el índice';

  -- 3) Sesiones de un artista
  p := pg_temp.plan_of($q$
    select id from public.sessions where artist_id = 'a0000000-0000-0000-0000-000000000007' $q$);
  raise notice E'sesiones por artista:\n%', p;
  assert p like '%sessions_artist_id_idx%' and p not like '%Seq Scan%',
    'sessions(artist_id): la consulta debe usar el índice';

  -- 5) Fase 4 — «Todo» de un artista: últimos elementos por cursor (created_at, id), 48 por página
  p := pg_temp.plan_of($q$
    select id from public.assets
    where artist_id = 'a0000000-0000-0000-0000-000000000007' and deleted_at is null
    order by created_at desc, id desc limit 48 $q$);
  raise notice E'listado Todo (primera página):
%', p;
  assert p like '%assets_artist_%idx%' and p not like '%Seq Scan%' and p not like '%Sort%',
    'listado por artista ordenado por fecha: debe usar índice sin ordenar aparte';

  -- 6) Fotos de un artista (pestaña Fotos), página siguiente con cursor
  p := pg_temp.plan_of($q$
    select id from public.assets
    where artist_id = 'a0000000-0000-0000-0000-000000000007' and kind = 'photo' and deleted_at is null
      and (created_at, id) < (now() - interval '100 minutes', 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
    order by created_at desc, id desc limit 48 $q$);
  raise notice E'pestaña Fotos con cursor:
%', p;
  assert p like '%assets_artist_kind_created_idx%' and p not like '%Seq Scan%',
    'listado por artista+tipo con cursor: debe usar assets_artist_kind_created_idx';

  -- 7) Contenido de una carpeta (la aplicación envía el id de la carpeta como constante)
  p := pg_temp.plan_of(format($q$
    select id from public.assets
    where artist_id = 'a0000000-0000-0000-0000-000000000007' and folder_id = %L and deleted_at is null
    order by created_at desc, id desc limit 48 $q$,
    (select id from public.folders where artist_id = 'a0000000-0000-0000-0000-000000000007' and kind = 'photos' and parent_id is null)));
  raise notice E'contenido de una carpeta:
%', p;
  assert p like '%Index%' and p not like '%Seq Scan%',
    'listado de una carpeta: debe usar un índice (nunca recorrer la tabla entera)';

  -- 4) Grants de un usuario sobre un recurso: la tabla está vacía aquí, así que se fuerza el índice
  --    para comprobar que EXISTE y es utilizable por la consulta que hace can_access.
  set local enable_seqscan = off;
  -- 8) Actividad de un artista (la tabla está vacía aquí: se fuerza el índice para comprobar que existe y sirve)
  p := pg_temp.plan_of($q$
    select id from public.activity_log
    where resource_type = 'artist' and resource_id = 'a0000000-0000-0000-0000-000000000007'
    order by created_at desc, id desc limit 30 $q$);
  raise notice E'actividad del artista:
%', p;
  assert p like '%activity_log_resource_created_idx%',
    'actividad por recurso: debe poder usar activity_log_resource_created_idx';

  p := pg_temp.plan_of($q$
    select id from public.grants
    where user_id = 'a0000000-0000-0000-0000-000000000001' and resource_type = 'artist'
      and resource_id = 'a0000000-0000-0000-0000-000000000007' $q$);
  raise notice E'grants por usuario+recurso:\n%', p;
  assert p like '%grants_user_resource_idx%' or p like '%grants_one_active_per_resource%',
    'grants(user_id, resource_type, resource_id): la consulta debe poder usar el índice';

  -- Fases 6, 9 y 10 (tablas vacías: se fuerza el índice para comprobar que EXISTE y sirve a la consulta real)
  p := pg_temp.plan_of($q$ select id from public.comments where asset_id = 'a0000000-0000-0000-0000-000000000007' and deleted_at is null order by timecode_ms, created_at $q$);
  assert p like '%comments_asset_time_idx%', 'comentarios de un archivo: debe usar comments_asset_time_idx';
  p := pg_temp.plan_of($q$ select id from public.notifications where user_id = 'a0000000-0000-0000-0000-000000000001' order by created_at desc limit 20 $q$);
  assert p like '%notifications_user_idx%', 'bandeja de avisos: debe usar notifications_user_idx';
  p := pg_temp.plan_of($q$ select id from public.share_links where token_hash = 'abc' $q$);
  assert p like '%share_links_token_hash_key%', 'enlace por hash del token: debe usar el índice único';
  p := pg_temp.plan_of($q$ select id from public.share_link_events where link_id = 'a0000000-0000-0000-0000-000000000007' order by created_at desc limit 100 $q$);
  assert p like '%share_link_events_link_idx%', 'historial de un enlace: debe usar share_link_events_link_idx';
  p := pg_temp.plan_of($q$ select id from public.notification_outbox where status = 'pending' and frequency = 'instant' order by created_at limit 500 $q$);
  assert p like '%notification_outbox_pending_idx%', 'cola de correo pendiente: debe usar notification_outbox_pending_idx';
  p := pg_temp.plan_of($q$ select status from public.backup_runs where kind = 'db' order by created_at desc limit 1 $q$);
  assert p like '%backup_runs_kind_idx%', 'última copia de seguridad: debe usar backup_runs_kind_idx';
  p := pg_temp.plan_of($q$ select id from public.error_log order by created_at desc limit 20 $q$);
  assert p like '%error_log_created_idx%', 'errores recientes: debe usar error_log_created_idx';
end $$;

rollback;

select 'EXPLAIN OK' as resultado;
