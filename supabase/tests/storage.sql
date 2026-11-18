-- MLS Drive — pruebas de almacenamiento (Fase 3)
--
-- Aplícalo después de 0001, 0002 y 0003. Termina en ROLLBACK (no deja datos).
-- Igual que permissions.sql: cada caso imprime OK/FALLO; si alguno falla, el script termina con un
-- error que los lista; si todo va bien, el último resultado es «STORAGE OK».

begin;

create temp table results (n serial primary key, ok boolean not null, label text not null);
grant insert, select on results to public;
grant usage on sequence results_n_seq to public;

create function pg_temp.chk(cond boolean, label text) returns void
language plpgsql as $$
begin
  insert into results (ok, label) values (coalesce(cond, false), label);
  raise notice '% %', case when coalesce(cond, false) then 'OK   ' else 'FALLO' end, label;
end $$;

create function pg_temp.act_as(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function pg_temp.sqlstate_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Usuarios: owner, admin, photographer (asignado al artista) y collaborator (asignado)
insert into public.invitations (email, role_id)
select v.email, r.id from (values
  ('owner@s.local', 'owner'), ('admin@s.local', 'admin'),
  ('photo@s.local', 'photographer'), ('collab@s.local', 'collaborator')
) as v(email, role_key) join public.roles r on r.key = v.role_key;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@s.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'admin@s.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'photo@s.local'),
  ('00000000-0000-0000-0000-0000000000b4', 'collab@s.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active' where email like '%@s.local';

insert into public.artists (id, name, slug) values ('10000000-0000-0000-0000-0000000000a1', 'Artista S', 'artista-s');
insert into public.artist_members (artist_id, user_id) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3'),
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b4');

-- Assets (published) en distintos estados de subida
insert into public.assets (id, kind, artist_id, original_filename, storage_key, status, visibility, downloadable, size_bytes, uploaded_by, upload_id, part_size_bytes) values
  ('40000000-0000-0000-0000-0000000000a1', 'photo', '10000000-0000-0000-0000-0000000000a1', 'ready.jpg',     's1', 'ready',     'published', true, 1000, '00000000-0000-0000-0000-0000000000b2', null, null),
  ('40000000-0000-0000-0000-0000000000a2', 'photo', '10000000-0000-0000-0000-0000000000a1', 'uploading.jpg', 's2', 'uploading', 'published', true, 2000, '00000000-0000-0000-0000-0000000000b3', 'UP-123', 16777216),
  ('40000000-0000-0000-0000-0000000000a3', 'photo', '10000000-0000-0000-0000-0000000000a1', 'failed.jpg',    's3', 'failed',    'published', true, 3000, '00000000-0000-0000-0000-0000000000b3', null, null),
  ('40000000-0000-0000-0000-0000000000a4', 'video', '10000000-0000-0000-0000-0000000000a1', 'clip.mp4',     's4', 'ready',     'published', true, 5000, '00000000-0000-0000-0000-0000000000b2', null, null),
  ('40000000-0000-0000-0000-0000000000a5', 'photo', '10000000-0000-0000-0000-0000000000a1', 'trashed.jpg',   's5', 'ready',     'published', true, 7000, '00000000-0000-0000-0000-0000000000b2', null, null);
update public.assets set deleted_at = now() where id = '40000000-0000-0000-0000-0000000000a5';
insert into public.asset_derivatives (asset_id, type, storage_key, size_bytes, status) values
  ('40000000-0000-0000-0000-0000000000a1', 'thumb', 's1t', 100, 'ready'),
  ('40000000-0000-0000-0000-0000000000a1', 'web', 's1w', 400, 'ready');

-- ---------------------------------------------------------------------------
-- 1. Estado de subida y visibilidad
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b4'); -- collaborator asignado
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a1') = 1, '1a. Un asset ready publicado se ve con acceso');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a2') = 0, '1b. Un asset en subida no lo ve quien no lo subió');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a3') = 0, '1c. Un asset FALLIDO no lo ve quien no lo subió');
  perform pg_temp.chk((select count(*) from public.assets) = 2, '1d. El collaborator ve solo los ready con acceso (foto a1 y vídeo a4), nada en subida, fallido ni papelera');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b3'); -- photographer: subió a2 y a3
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a2') = 1, '1e. Quien sube ve su asset en subida (para reanudar)');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a3') = 1, '1f. ...y su asset fallido (para reintentar)');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a4') = 0, '1g. photographer no ve vídeos (sin videos.view)');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2'); -- admin (scope all) no subió a2/a3
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id in ('40000000-0000-0000-0000-0000000000a2', '40000000-0000-0000-0000-0000000000a3')) = 0,
    '1h. Ni siquiera un admin ve subidas ajenas inacabadas o fallidas');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a1') = 1, '1i. ...pero sí los ready');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-0000000000a5') = 0, '1j. Un asset en la papelera no se ve');
  perform pg_temp.chk((select count(*) from public.asset_derivatives) = 2, '1k. Los derivados de un asset visible se ven');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. Columnas de seguimiento: el cliente nunca debe poder escribirlas ni cambiar nada
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b3');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set status = 'ready' where id = '40000000-0000-0000-0000-0000000000a2' $q$) = '42501',
    '2a. El cliente NO puede marcar su subida como ready (solo el servidor, tras comprobar el tamaño)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set upload_id = 'otro' where id = '40000000-0000-0000-0000-0000000000a2' $q$) = '42501',
    '2b. El cliente NO puede cambiar el uploadId');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.set_asset_visibility('40000000-0000-0000-0000-0000000000a2', 'published', auth.uid()) $q$) = '42501',
    '2c. set_asset_visibility no es invocable por usuarios');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select * from public.storage_usage() $q$) = '42501',
    '2d. storage_usage no es invocable por usuarios');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Publicar con autor (función de servidor) y su rastro en activity_log
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims', '', true); -- sin sesión, como el service role
  perform public.set_asset_visibility('40000000-0000-0000-0000-0000000000a1', 'private', '00000000-0000-0000-0000-0000000000b2');
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.unpublished'
      and resource_id = '40000000-0000-0000-0000-0000000000a1' and actor_id = '00000000-0000-0000-0000-0000000000b2'),
    '3a. Despublicar con set_asset_visibility registra al autor');
  perform public.set_asset_visibility('40000000-0000-0000-0000-0000000000a1', 'published', '00000000-0000-0000-0000-0000000000b1');
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.published'
      and resource_id = '40000000-0000-0000-0000-0000000000a1' and actor_id = '00000000-0000-0000-0000-0000000000b1'),
    '3b. Publicar registra al autor correcto');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Uso de almacenamiento: solo assets ready y no borrados (+ derivados aparte)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  select * into r from public.storage_usage() where kind = 'photo';
  perform pg_temp.chk(r.files = 1 and r.bytes = 1000, '4a. Fotos: no cuentan subidas en curso, fallidas ni borradas (1 archivo, 1000 bytes)');
  select * into r from public.storage_usage() where kind = 'video';
  perform pg_temp.chk(r.files = 1 and r.bytes = 5000, '4b. Vídeos: 1 archivo, 5000 bytes');
  -- Desde la Fase 6 los derivados se desglosan por tipo (derivative:thumb, derivative:web, …)
  select coalesce(sum(files), 0)::bigint as files, coalesce(sum(bytes), 0)::bigint as bytes into r from public.storage_usage() where kind like 'derivative:%';
  perform pg_temp.chk(r.files = 2 and r.bytes = 500, '4c. Derivados: 2 archivos, 500 bytes (sumando los tipos)');
  perform pg_temp.chk((select count(*) from public.storage_usage() where kind = 'photo' and artist_id = '10000000-0000-0000-0000-0000000000a1') = 1,
    '4d. El uso se desglosa por artista');
end $$;

-- ---------------------------------------------------------------------------
-- Resultado
-- ---------------------------------------------------------------------------
do $$
declare
  v_failed text;
begin
  select string_agg(label, '; ' order by n) into v_failed from results where not ok;
  if v_failed is not null then
    raise exception 'Fallan % casos: %', (select count(*) from results where not ok), v_failed;
  end if;
end $$;

select n, case when ok then 'OK' else 'FALLO' end as resultado, label as caso from results order by n;

rollback;

select 'STORAGE OK' as resultado;
