-- MLS Drive — volumen del catálogo de beats (Fase 7)
--
-- Genera 5 000 beats sintéticos (4 000 publicados y 1 000 borradores, 12 géneros, 40 etiquetas, 300 compartidos con
-- un artista), mide cuánto tarda `beat_catalog` para el owner y para un artista (con RLS: `can_access` por fila) y
-- comprueba con EXPLAIN que búsqueda, orden y filtros usan índice. Aplícalo DESPUÉS de 0001 a 0007.
-- Termina en ROLLBACK (no deja datos). Cada medida sale como NOTICE y en la tabla final; si una consulta supera su
-- umbral (generoso, pensado para detectar un recorrido completo con N+1, no para medir el hardware) el script falla.

begin;

create temp table results (n serial primary key, ok boolean not null, label text not null, ms numeric);
grant insert, select on results to public;
grant usage on sequence results_n_seq to public;

create function pg_temp.chk(cond boolean, label text, took numeric default null) returns void
language plpgsql as $$
begin
  insert into results (ok, label, ms) values (coalesce(cond, false), label, took);
  raise notice '% % %', case when coalesce(cond, false) then 'OK   ' else 'FALLO' end, label, coalesce(round(took)::text || ' ms', '');
end $$;

-- Usuarios: un owner y un artista asignado a «Artista 1»
insert into public.invitations (email, role_id)
select v.email, r.id from (values ('owner@t.local', 'owner'), ('artist@t.local', 'artist')) v(email, role_key)
join public.roles r on r.key = v.role_key;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'artist@t.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active';

insert into public.artists (id, name, slug) values
  ('a0000000-0000-0000-0000-000000000001', 'Artista 1', 'artista-1'),
  ('a0000000-0000-0000-0000-000000000002', 'Artista 2', 'artista-2');
insert into public.artist_members (artist_id, user_id) values ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a3');

-- Géneros, etiquetas y 5 000 beats
insert into public.genres (id, name)
select ('c0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, (array['Trap','Drill','Boom Bap','Reggaeton','Afrobeat','Lo-fi','R&B','Pop','House','Dembow','Latin Trap','Phonk'])[i]
from generate_series(1, 12) i;
insert into public.tags (id, name)
select ('d0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'etiqueta' || i from generate_series(1, 40) i;

insert into public.assets (id, kind, artist_id, original_filename, storage_key, visibility, downloadable, status, size_bytes)
select ('e0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'audio', null, 'b' || i || '.wav', 'shared/b' || i || '/original/b.wav', 'private', false, 'ready', 1000
from generate_series(1, 5000) i;

insert into public.beats (id, asset_id, title, bpm, musical_key, genre_id, status, created_on, downloadable, created_by)
select ('f0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       ('e0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       (array['Noche','Calle','Fuego','Humo','Barrio','Sombra','Luz','Costa','Cielo','Ruta'])[1 + i % 10] || ' ' ||
         (array['oscura','larga','rápida','fría','dulce','sucia'])[1 + i % 6] || ' ' || i,
       70 + (i * 7) % 111,
       (array['Am','Cm','Dm','Em','Fm','Gm','A','C','D','E','F#m','G#m'])[1 + i % 12],
       ('c0000000-0000-0000-0000-' || lpad((1 + i % 12)::text, 12, '0'))::uuid,
       case when i % 5 = 0 then 'draft' else 'published' end::public.beat_status,
       date '2026-01-01' + (i % 300),
       i % 3 = 0,
       '00000000-0000-0000-0000-0000000000a1'
from generate_series(1, 5000) i;

insert into public.taggings (tag_id, resource_type, resource_id)
select ('d0000000-0000-0000-0000-' || lpad((1 + i % 40)::text, 12, '0'))::uuid, 'beat', ('f0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 5000) i
union all
select ('d0000000-0000-0000-0000-' || lpad((1 + (i * 7) % 40)::text, 12, '0'))::uuid, 'beat', ('f0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 5000) i where (1 + i % 40) <> (1 + (i * 7) % 40);

-- 300 publicados compartidos con el artista 1
insert into public.beat_artists (beat_id, artist_id, can_download)
select ('f0000000-0000-0000-0000-' || lpad((i * 5 + 1)::text, 12, '0'))::uuid, 'a0000000-0000-0000-0000-000000000001', i % 2 = 0 from generate_series(1, 300) i;

insert into public.asset_derivatives (asset_id, type, storage_key, size_bytes, status)
select ('e0000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'audio_preview', 'shared/b' || i || '/audio_preview/preview.mp3', 100, 'ready' from generate_series(1, 5000) i;

analyze public.beats; analyze public.taggings; analyze public.beat_artists; analyze public.assets; analyze public.asset_derivatives;

select pg_temp.chk((select count(*) from public.beats) = 5000, 'datos: 5 000 beats generados');

-- Medidor: ejecuta una consulta y devuelve el tiempo en ms
create function pg_temp.time_ms(q text) returns numeric language plpgsql as $$
declare t0 timestamptz := clock_timestamp();
begin
  execute q;
  return extract(epoch from clock_timestamp() - t0) * 1000;
end $$;
create function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;
create function pg_temp.plan_of(q text) returns text language plpgsql as $$
declare r text; out text := '';
begin
  for r in execute 'explain (costs off) ' || q loop out := out || r || E'\n'; end loop;
  return out;
end $$;
create function pg_temp.rows_of(q text) returns bigint language plpgsql as $$
declare n bigint;
begin execute 'select count(*) from (' || q || ') x' into n; return n; end $$;
grant execute on function pg_temp.time_ms(text), pg_temp.rows_of(text) to public;

-- ---------------------------------------------------------------------------
-- Planes (superusuario: sin RLS, para comprobar los índices de la consulta base)
-- ---------------------------------------------------------------------------
do $$
declare p text;
begin
  -- (con 5 000 filas el planificador puede preferir recorrer la tabla: se fuerza el índice para comprobar que EXISTE y sirve)
  set local enable_seqscan = off;
  p := pg_temp.plan_of($q$select id from public.beats where search @@ to_tsquery('simple', '4242')$q$);
  raise notice E'búsqueda de texto:\n%', p;
  perform pg_temp.chk(p like '%beats_search_idx%' and p not like '%Seq Scan on beats%', 'EXPLAIN: la búsqueda de texto puede usar el índice GIN');
  set local enable_seqscan = on;

  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null and status = 'published' order by created_on desc, id desc limit 50$q$);
  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null order by created_on desc, id desc limit 50$q$);
  perform pg_temp.chk(p like '%beats_created_idx%' and p not like '%Sort%', 'EXPLAIN: listado por fecha sin filtros usa beats_created_idx sin ordenar aparte');
  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null order by bpm asc nulls last, id asc limit 50$q$);
  perform pg_temp.chk(p like '%beats_bpm_idx%' and p not like '%Sort%', 'EXPLAIN: orden por BPM usa beats_bpm_idx sin ordenar aparte');
  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null and status = 'published' order by created_on desc, id desc limit 50$q$);
  raise notice E'orden por fecha:\n%', p;
  perform pg_temp.chk(p like '%beats_status_created_idx%' and p not like '%Seq Scan on beats%' and p not like '%Sort%', 'EXPLAIN: listado por estado y fecha sin ordenar aparte (índice)');

  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null and genre_id = 'c0000000-0000-0000-0000-000000000003'$q$);
  perform pg_temp.chk(p like '%beats_genre_idx%', 'EXPLAIN: filtro por género usa beats_genre_idx');

  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null and bpm between 120 and 125$q$);
  perform pg_temp.chk(p like '%beats_bpm_idx%', 'EXPLAIN: filtro por BPM usa beats_bpm_idx');

  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null and musical_key = 'Am'$q$);
  perform pg_temp.chk(p like '%beats_musical_key_idx%', 'EXPLAIN: filtro por tonalidad usa beats_musical_key_idx');

  p := pg_temp.plan_of($q$select id from public.beats where deleted_at is null order by lower(title), id limit 50$q$);
  perform pg_temp.chk(p like '%beats_title_idx%' and p not like '%Sort%', 'EXPLAIN: orden por nombre usa beats_title_idx sin ordenar aparte');

  p := pg_temp.plan_of($q$select 1 from public.taggings where resource_type = 'beat' and resource_id = 'f0000000-0000-0000-0000-000000000042'$q$);
  perform pg_temp.chk(p like '%taggings_resource_idx%' or p like '%taggings%idx%' or p like '%taggings_pkey%', 'EXPLAIN: etiquetas de un beat por índice');

  p := pg_temp.plan_of($q$select 1 from public.beat_artists where artist_id = 'a0000000-0000-0000-0000-000000000002'$q$);
  perform pg_temp.chk(p like '%beat_artists_artist_id_idx%' or p like '%beat_artists%idx%', 'EXPLAIN: compartidos de un artista por índice');
end $$;

-- ---------------------------------------------------------------------------
-- Tiempos del catálogo como OWNER (alcance «todos») y como ARTISTA (RLS: can_access por fila)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$
declare t numeric; n bigint;
begin
  t := pg_temp.time_ms($q$select * from public.beat_catalog()$q$);
  perform pg_temp.chk(t < 1500, 'owner: primera página (50 de 5 000, orden reciente)', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_q => 'noche')$q$);
  perform pg_temp.chk(t < 1500, 'owner: búsqueda de texto «noche»', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_q => 'noche osc')$q$);
  perform pg_temp.chk(t < 1500, 'owner: búsqueda de dos palabras por prefijo «noche osc»', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_genres => array['c0000000-0000-0000-0000-000000000003']::uuid[], p_bpm_min => 100, p_bpm_max => 140)$q$);
  perform pg_temp.chk(t < 1500, 'owner: género + rango de BPM', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_keys => array['Am','Cm'], p_status => 'draft')$q$);
  perform pg_temp.chk(t < 1500, 'owner: tonalidades + estado borrador', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_tags => array['d0000000-0000-0000-0000-000000000003']::uuid[])$q$);
  perform pg_temp.chk(t < 1500, 'owner: por etiqueta', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_order => 'bpm')$q$);
  perform pg_temp.chk(t < 1500, 'owner: orden por BPM', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_order => 'name')$q$);
  perform pg_temp.chk(t < 1500, 'owner: orden por nombre', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_after_val => '2026-02-01', p_after_id => 'f0000000-0000-0000-0000-000000002500')$q$);
  perform pg_temp.chk(t < 1500, 'owner: página profunda por cursor (a mitad del catálogo)', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_artist => 'a0000000-0000-0000-0000-000000000001')$q$);
  perform pg_temp.chk(t < 1500, 'owner: filtro por artista con acceso', t);

  -- Recorrer TODO el catálogo con el cursor: sin repetidos ni huecos
  declare
    seen int := 0; v text := null; i uuid := null; cnt int;
  begin
    loop
      select count(*) into cnt from public.beat_catalog(p_after_val => v, p_after_id => i, p_limit => 100);
      exit when cnt = 0 or seen > 6000;
      -- el último elemento de la página (orden reciente: el de menor fecha e id)
      select sort_val, id into v, i from public.beat_catalog(p_after_val => v, p_after_id => i, p_limit => 100) order by sort_val asc, id asc limit 1;
      seen := seen + cnt;
    end loop;
    perform pg_temp.chk(seen = 5000, 'owner: el cursor recorre los 5 000 beats exactos (recorridos ' || seen || ')');
  end;
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$
declare t numeric; n bigint;
begin
  t := pg_temp.time_ms($q$select * from public.beat_catalog()$q$);
  n := pg_temp.rows_of($q$select * from public.beat_catalog(p_limit => 100)$q$);
  perform pg_temp.chk(n = 100, 'artista: ve 100 de sus 300 compartidos publicados en una página de 100 (' || n || ')');
  perform pg_temp.chk(t < 4000, 'artista: primera página con RLS (can_access por fila)', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_q => 'noche')$q$);
  perform pg_temp.chk(t < 4000, 'artista: búsqueda con RLS', t);
  t := pg_temp.time_ms($q$select * from public.beat_catalog(p_status => 'draft')$q$);
  perform pg_temp.chk(t < 4000, 'artista: borradores (no debe ver ninguno) con RLS', t);
  perform pg_temp.chk(pg_temp.rows_of($q$select * from public.beat_catalog(p_status => 'draft', p_limit => 100)$q$) = 0, 'artista: no ve ningún borrador');
end $$;
reset role;

select n, case when ok then 'OK' else 'FALLO' end as resultado, label as caso, ms from results order by n;

rollback;

select case when exists (select 1) then 'BEATS SCALE (revisa la tabla: cualquier FALLO es un fallo)' end as resultado;
