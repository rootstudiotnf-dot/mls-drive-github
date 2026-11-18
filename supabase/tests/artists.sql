-- MLS Drive — pruebas de espacios por artista (Fase 4)
--
-- Aplícalo después de 0001, 0002, 0003 y 0004. Termina en ROLLBACK (no deja datos).
-- Cada caso imprime OK/FALLO; si alguno falla, el script termina con un error que los lista;
-- si todo va bien, el último resultado es «ARTISTS OK».
--
-- Cubre: carpetas base, nombres únicos, resúmenes bajo RLS, flujo de publicación (subir → pendiente →
-- publicar → el artista lo ve), revocación inmediata, mover entre artistas, papelera, actividad paginada.

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

-- ---------------------------------------------------------------------------
-- Usuarios: owner, admin, artist (A), artist (B), filmmaker (rol personalizado), desactivado, colaborador (B)
-- ---------------------------------------------------------------------------
insert into public.roles (key, name, scope, description) values ('filmmaker', 'Filmmaker', 'assigned', 'Solo ver y subir vídeos');
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['videos.view', 'videos.upload']) k where r.key = 'filmmaker';

insert into public.invitations (email, role_id)
select v.email, r.id from (values
  ('owner@a.local', 'owner'), ('admin@a.local', 'admin'), ('artist-a@a.local', 'artist'),
  ('artist-b@a.local', 'artist'), ('film@a.local', 'filmmaker'), ('off@a.local', 'artist'),
  ('collab-b@a.local', 'collaborator')
) as v(email, role_key) join public.roles r on r.key = v.role_key;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@a.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'admin@a.local'),
  ('00000000-0000-0000-0000-0000000000c3', 'artist-a@a.local'),
  ('00000000-0000-0000-0000-0000000000c4', 'artist-b@a.local'),
  ('00000000-0000-0000-0000-0000000000c5', 'film@a.local'),
  ('00000000-0000-0000-0000-0000000000c6', 'off@a.local'),
  ('00000000-0000-0000-0000-0000000000c7', 'collab-b@a.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active' where email like '%@a.local' and email <> 'off@a.local';

-- Artistas (el trigger crea sus carpetas base)
insert into public.artists (id, name, slug) values
  ('a1000000-0000-0000-0000-000000000001', 'Artista A', 'artista-a'),
  ('a1000000-0000-0000-0000-000000000002', 'Artista B', 'artista-b');

insert into public.artist_members (artist_id, user_id) values
  ('a1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3'),
  ('a1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c5'),
  ('a1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c4'),
  ('a1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c7');

-- ---------------------------------------------------------------------------
-- 1. Carpetas base
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.chk((select count(*) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001') = 3, '1a. Crear un artista genera 3 carpetas base');
  perform pg_temp.chk((select array_agg(kind::text order by sort) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001' and parent_id is null) = array['photos', 'videos', 'files'], '1b. Son Fotos, Vídeos y Archivos (kinds photos, videos, files)');
  perform pg_temp.chk((select array_agg(name order by sort) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001') = array['Fotos', 'Vídeos', 'Archivos'], '1c. Con los nombres en español');
  perform public.create_artist_defaults('a1000000-0000-0000-0000-000000000001');
  perform pg_temp.chk((select count(*) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001') = 3, '1d. create_artist_defaults es idempotente (no duplica)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.create_artist_defaults('a1000000-0000-0000-0000-000000000001') $q$) is null, '1e. ...y el servidor (postgres/service role) puede llamarla');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Nombres únicos por carpeta madre (entre las no borradas)
-- ---------------------------------------------------------------------------
do $$
declare
  v_fotos uuid; v_videos uuid; v_bts uuid;
begin
  select id into v_fotos from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001' and kind = 'photos' and parent_id is null;
  select id into v_videos from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001' and kind = 'videos' and parent_id is null;
  insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000001', v_fotos, 'BTS', 'photos') returning id into v_bts;

  perform pg_temp.chk(pg_temp.sqlstate_of(format($q$ insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000001', %L, 'bts', 'photos') $q$, v_fotos)) = '23505',
    '2a. Mismo nombre en la misma carpeta madre (sin distinguir mayúsculas): rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of(format($q$ insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000001', %L, 'BTS', 'videos') $q$, v_videos)) is null,
    '2b. El mismo nombre en OTRA carpeta madre: permitido');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000001', null, 'fotos', 'photos') $q$) = '23505',
    '2c. Tampoco se repite entre carpetas de primer nivel');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000002', null, 'Extras', 'files') $q$) is null,
    '2d. Otro artista puede usar cualquier nombre');

  update public.folders set deleted_at = now() where id = v_bts;
  perform pg_temp.chk(pg_temp.sqlstate_of(format($q$ insert into public.folders (artist_id, parent_id, name, kind) values ('a1000000-0000-0000-0000-000000000001', %L, 'BTS', 'photos') $q$, v_fotos)) is null,
    '2e. Una carpeta borrada no bloquea reutilizar su nombre');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Avatar como asset
-- ---------------------------------------------------------------------------
insert into public.assets (id, kind, artist_id, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('b1000000-0000-0000-0000-000000000090', 'photo', 'a1000000-0000-0000-0000-000000000001', 'avatar.jpg', 'k-avatar', 'ready', 'published', false, '00000000-0000-0000-0000-0000000000c2');
do $$
begin
  perform pg_temp.chk(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'artists' and column_name = 'avatar_key'), '3a. avatar_key ya no existe');
  update public.artists set avatar_asset_id = 'b1000000-0000-0000-0000-000000000090' where id = 'a1000000-0000-0000-0000-000000000001';
  perform pg_temp.chk((select avatar_asset_id from public.artists where id = 'a1000000-0000-0000-0000-000000000001') = 'b1000000-0000-0000-0000-000000000090', '3b. El avatar es una referencia a un asset');
  delete from public.assets where id = 'b1000000-0000-0000-0000-000000000090';
  perform pg_temp.chk((select avatar_asset_id from public.artists where id = 'a1000000-0000-0000-0000-000000000001') is null, '3c. Si el asset desaparece, el avatar queda vacío (set null)');
end $$;

-- ---------------------------------------------------------------------------
-- Contenido del artista A
-- ---------------------------------------------------------------------------
insert into public.sessions (id, artist_id, name) values
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Sesión 1'),
  ('c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'Sesión 2'),
  ('c1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'Sesión borrada');
update public.sessions set deleted_at = now() where id = 'c1000000-0000-0000-0000-000000000003';

insert into public.assets (id, kind, artist_id, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('b1000000-0000-0000-0000-000000000001', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p1.jpg', 'ka1', 'ready',     'published', true,  '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000002', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p2.jpg', 'ka2', 'ready',     'published', true,  '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000003', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p3.jpg', 'ka3', 'ready',     'published', false, '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000004', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p4-privada.jpg', 'ka4', 'ready', 'private', false, '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000005', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p5-papelera.jpg', 'ka5', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000006', 'photo',    'a1000000-0000-0000-0000-000000000001', 'p6-subiendo.jpg', 'ka6', 'uploading', 'published', true, '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000007', 'video',    'a1000000-0000-0000-0000-000000000001', 'v1.mp4', 'ka7', 'ready',     'published', true,  '00000000-0000-0000-0000-0000000000c2'),
  ('b1000000-0000-0000-0000-000000000008', 'video',    'a1000000-0000-0000-0000-000000000001', 'v2-pendiente.mp4', 'ka8', 'ready', 'private', false, '00000000-0000-0000-0000-0000000000c5'),
  ('b1000000-0000-0000-0000-000000000009', 'document', 'a1000000-0000-0000-0000-000000000001', 'doc.pdf', 'ka9', 'ready',   'published', true,  '00000000-0000-0000-0000-0000000000c2');
update public.assets set deleted_at = now() where id = 'b1000000-0000-0000-0000-000000000005';

-- Un beat compartido con alguien de A, y accesos de A: grant de artista para c7 (colaborador de B)
insert into public.assets (id, kind, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('b1000000-0000-0000-0000-0000000000a1', 'audio', 'beat.wav', 'kb1', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000c1');
insert into public.beats (id, asset_id, title, status, downloadable, created_by) values
  ('d1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-0000000000a1', 'Beat de prueba', 'published', true, '00000000-0000-0000-0000-0000000000c1');
insert into public.grants (user_id, resource_type, resource_id, can_view, can_download) values
  ('00000000-0000-0000-0000-0000000000c3', 'beat', 'd1000000-0000-0000-0000-000000000001', true, false),
  ('00000000-0000-0000-0000-0000000000c7', 'artist', 'a1000000-0000-0000-0000-000000000001', true, true);

-- ---------------------------------------------------------------------------
-- 4. Resúmenes (artist_summary) bajo RLS
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2'); -- admin: scope all
do $$
declare
  r record;
begin
  select * into r from public.artist_summary('a1000000-0000-0000-0000-000000000001');
  perform pg_temp.chk(r.sessions = 2, '4a. admin: 2 sesiones (la borrada no cuenta)');
  perform pg_temp.chk(r.photos = 4, '4b. admin: 4 fotos listas (sin papelera ni subidas en curso)');
  perform pg_temp.chk(r.videos = 2, '4c. admin: 2 vídeos');
  perform pg_temp.chk(r.files = 1, '4d. admin: 1 archivo');
  perform pg_temp.chk(r.pending = 2, '4e. admin: 2 pendientes de publicar (foto y vídeo privados)');
  perform pg_temp.chk(r.members = 3, '4f. admin: 3 personas con acceso (2 asignadas + 1 con acceso al artista)');
  perform pg_temp.chk(r.beats_shared = 1, '4g. admin: 1 beat compartido con personas del artista');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3'); -- artist asignado a A
do $$
declare
  r record;
begin
  select * into r from public.artist_summary('a1000000-0000-0000-0000-000000000001');
  perform pg_temp.chk(r.photos = 3 and r.videos = 1 and r.files = 1, '4h. artist: solo cuenta lo PUBLICADO que ve (3 fotos, 1 vídeo, 1 archivo)');
  perform pg_temp.chk(r.pending = 0, '4i. artist: no ve ni cuenta lo pendiente de publicar');
  perform pg_temp.chk((select count(*) from public.artist_summaries()) = 1, '4j. artist: artist_summaries devuelve SOLO su artista');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.create_artist_defaults('a1000000-0000-0000-0000-000000000001') $q$) = '42501', '4k. artist: no puede llamar a create_artist_defaults');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c4'); -- artist asignado a B
do $$
declare
  r record;
begin
  select * into r from public.artist_summary('a1000000-0000-0000-0000-000000000001');
  perform pg_temp.chk(r.sessions = 0 and r.photos = 0 and r.videos = 0 and r.files = 0 and r.pending = 0, '4l. artist de B: del artista A no cuenta NADA');
  perform pg_temp.chk((select count(*) from public.assets where artist_id = 'a1000000-0000-0000-0000-000000000001') = 0, '4m. artist de B: no lee assets de A (ni por consulta directa)');
  perform pg_temp.chk((select count(*) from public.artists where id = 'a1000000-0000-0000-0000-000000000001') = 0, '4n. artist de B: ni siquiera ve la fila del artista A');
  perform pg_temp.chk((select count(*) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001') = 0, '4o. ...ni sus carpetas');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c6'); -- usuario desactivado
do $$
declare
  r record;
begin
  select * into r from public.artist_summary('a1000000-0000-0000-0000-000000000001');
  perform pg_temp.chk(r.photos = 0 and r.sessions = 0, '4p. usuario desactivado: todo a cero');
  perform pg_temp.chk((select count(*) from public.artists) = 0, '4q. usuario desactivado: no ve artistas');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 5. Carpetas: conteos y borrado lógico
-- ---------------------------------------------------------------------------
update public.assets set folder_id = (select id from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001' and kind = 'photos' and parent_id is null)
where id in ('b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000004');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
do $$
begin
  perform pg_temp.chk((select items from public.folder_counts('a1000000-0000-0000-0000-000000000001')) = 3, '5a. folder_counts: la carpeta Fotos tiene 3 elementos');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform pg_temp.chk((select items from public.folder_counts('a1000000-0000-0000-0000-000000000001')) = 2, '5b. folder_counts bajo RLS: el artist cuenta solo los publicados (2)');
end $$;
reset role;

update public.folders set deleted_at = now() where artist_id = 'a1000000-0000-0000-0000-000000000001' and name = 'Archivos';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
do $$
begin
  perform pg_temp.chk((select count(*) from public.folders where artist_id = 'a1000000-0000-0000-0000-000000000001' and name = 'Archivos') = 0, '5c. Una carpeta borrada deja de verse (RLS), incluso para el admin');
end $$;
reset role;
update public.folders set deleted_at = null where artist_id = 'a1000000-0000-0000-0000-000000000001' and name = 'Archivos';

-- ---------------------------------------------------------------------------
-- 6. Flujo de publicación: se sube → pendiente → el artista no lo ve → se publica → lo ve
-- ---------------------------------------------------------------------------
insert into public.assets (id, kind, artist_id, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('b1000000-0000-0000-0000-0000000000f1', 'video', 'a1000000-0000-0000-0000-000000000001', 'clip-colaborador.mp4', 'kf1', 'ready', 'private', true, '00000000-0000-0000-0000-0000000000c5');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c5'); -- filmmaker (subió el vídeo)
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-0000000000f1') = 1, '6a. El colaborador ve lo que él subió (queda pendiente)');
  perform pg_temp.chk(public.can_access(auth.uid(), 'upload', 'artist', 'a1000000-0000-0000-0000-000000000001'), '6b. El colaborador (solo vídeos) puede subir a su artista asignado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'publish', 'asset', 'b1000000-0000-0000-0000-0000000000f1'), '6c. ...pero NO puede publicar (sin videos.publish)');
  perform pg_temp.chk((select count(*) from public.assets where kind = 'photo') = 0, '6d. Filmmaker: no ve fotos (solo tiene videos.*)');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3'); -- artist asignado a A
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-0000000000f1') = 0, '6e. El artista NO ve el vídeo pendiente de publicar');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', 'b1000000-0000-0000-0000-0000000000f1'), '6f. ...ni puede descargarlo');
end $$;
reset role;

-- Fase 6: un vídeo solo se publica si su trabajo de procesado está listo
insert into public.media_jobs (asset_id, status, finished_at) values ('b1000000-0000-0000-0000-0000000000f1', 'ready', now());
do $$ begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.actor_id', '00000000-0000-0000-0000-0000000000c2', true);
  update public.assets set visibility = 'published' where id = 'b1000000-0000-0000-0000-0000000000f1'; -- el admin publica
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-0000000000f1') = 1, '6g. Publicado: el artista lo ve');
  perform pg_temp.chk(public.can_access(auth.uid(), 'download', 'asset', 'b1000000-0000-0000-0000-0000000000f1'), '6h. ...y puede descargarlo (downloadable = true)');
end $$;
reset role;

do $$ begin
  perform set_config('request.jwt.claims', '', true);
  update public.assets set visibility = 'private' where id = 'b1000000-0000-0000-0000-0000000000f1'; -- se despublica
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-0000000000f1') = 0, '6i. Despublicado: el artista deja de verlo al instante');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7. Revocación inmediata
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c7'); -- colaborador de B con grant sobre A
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-000000000001') = 1, '7a. Con el acceso vigente al artista A, ve su contenido publicado');
end $$;
reset role;

update public.grants set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000c7' and resource_type = 'artist';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c7');
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where artist_id = 'a1000000-0000-0000-0000-000000000001') = 0, '7b. Al REVOCAR el acceso deja de ver el contenido de A (inmediato)');
  perform pg_temp.chk((select count(*) from public.artists where id = 'a1000000-0000-0000-0000-000000000001') = 0, '7c. ...y de ver al artista');
end $$;
reset role;

delete from public.artist_members where artist_id = 'a1000000-0000-0000-0000-000000000001' and user_id = '00000000-0000-0000-0000-0000000000c3';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform pg_temp.chk((select count(*) from public.assets where artist_id = 'a1000000-0000-0000-0000-000000000001') = 0, '7d. Quitar a la persona del espacio corta su acceso al instante');
end $$;
reset role;
insert into public.artist_members (artist_id, user_id) values ('a1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3');

-- ---------------------------------------------------------------------------
-- 8. Mover entre artistas (solo filas: la storage_key no cambia)
-- ---------------------------------------------------------------------------
do $$
declare
  v_key text;
begin
  select storage_key into v_key from public.assets where id = 'b1000000-0000-0000-0000-000000000001';
  update public.assets set artist_id = 'a1000000-0000-0000-0000-000000000002', folder_id = null where id = 'b1000000-0000-0000-0000-000000000001';
  perform pg_temp.chk((select storage_key from public.assets where id = 'b1000000-0000-0000-0000-000000000001') = v_key, '8a. Mover entre artistas no toca la storage_key');
end $$;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c4'); -- artist de B
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-000000000001') = 1, '8b. El artist de B ve la foto movida a B');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3'); -- artist de A
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-000000000001') = 0, '8c. El artist de A deja de verla');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 9. Papelera: lo borrado no lo ve nadie por RLS (se gestiona desde servidor)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-000000000005') = 0, '9a. Un asset en la papelera no lo ve ni el owner por RLS');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', 'b1000000-0000-0000-0000-000000000005'), '9b. can_access lo deniega');
end $$;
reset role;
update public.assets set deleted_at = null where id = 'b1000000-0000-0000-0000-000000000005';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = 'b1000000-0000-0000-0000-000000000005') = 1, '9c. Restaurar un asset de la papelera lo hace visible otra vez para quien tiene acceso');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 10. Actividad del artista (paginada, solo para quien gestiona accesos)
-- ---------------------------------------------------------------------------
insert into public.activity_log (id, actor_id, action, resource_type, resource_id, created_at) values
  ('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c2', 'asset.published',  'asset',  'b1000000-0000-0000-0000-000000000002', now() - interval '5 minutes'),
  ('e1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c5', 'upload.completed', 'asset',  'b1000000-0000-0000-0000-000000000008', now() - interval '4 minutes'),
  ('e1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c3', 'asset.downloaded', 'asset',  'b1000000-0000-0000-0000-000000000007', now() - interval '3 minutes'),
  ('e1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000c2', 'grant.created',    'artist', 'a1000000-0000-0000-0000-000000000001', now() - interval '2 minutes'),
  ('e1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000c5', 'upload.init',      'asset',  'b1000000-0000-0000-0000-000000000008', now() - interval '1 minute'),
  ('e1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-0000000000c2', 'asset.published',  'asset',  'b1000000-0000-0000-0000-000000000002'::uuid, now() - interval '1 hour');
insert into public.assets (id, kind, artist_id, original_filename, storage_key, status, visibility, uploaded_by) values
  ('b1000000-0000-0000-0000-0000000000b9', 'photo', 'a1000000-0000-0000-0000-000000000002', 'b.jpg', 'kb9', 'ready', 'published', '00000000-0000-0000-0000-0000000000c2');
insert into public.activity_log (id, actor_id, action, resource_type, resource_id, created_at) values
  ('e1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-0000000000c2', 'asset.published', 'asset', 'b1000000-0000-0000-0000-0000000000b9', now());

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  page1 uuid[]; page2 uuid[]; last_at timestamptz; last_id uuid;
begin
  perform pg_temp.chk((select count(*) from public.artist_activity('a1000000-0000-0000-0000-000000000001', null, null, 100) where id::text like 'e1000000-%') = 5, '10a. Actividad de A: los 5 eventos sembrados (sin upload.init ni los de otro artista)');
  perform pg_temp.chk(not exists (select 1 from public.artist_activity('a1000000-0000-0000-0000-000000000001') where action = 'upload.init'), '10b. Se excluye el ruido de upload.init');
  perform pg_temp.chk(not exists (select 1 from public.artist_activity('a1000000-0000-0000-0000-000000000001') where resource_id = 'b1000000-0000-0000-0000-0000000000b9'), '10c. No mezcla eventos de otro artista');
  perform pg_temp.chk((select action from public.artist_activity('a1000000-0000-0000-0000-000000000001', null, null, 100) where id::text like 'e1000000-%' limit 1) in ('asset.published', 'upload.completed', 'asset.downloaded', 'grant.created'), '10d. Devuelve eventos del artista');

  select array_agg(id) into page1 from public.artist_activity('a1000000-0000-0000-0000-000000000001', null, null, 2);
  select created_at, id into last_at, last_id from public.artist_activity('a1000000-0000-0000-0000-000000000001', null, null, 2) order by created_at asc, id asc limit 1;
  select array_agg(id) into page2 from public.artist_activity('a1000000-0000-0000-0000-000000000001', last_at, last_id, 2);
  perform pg_temp.chk(cardinality(page1) = 2 and cardinality(page2) = 2 and not (page1 && page2), '10e. Paginación por cursor: páginas de 2 sin solaparse');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000c3'); -- sin access.manage
do $$ begin
  perform pg_temp.chk((select count(*) from public.artist_activity('a1000000-0000-0000-0000-000000000001')) = 0, '10f. Sin access.manage no se ve la actividad');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 11. Permiso artists.manage
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.chk(exists (select 1 from public.permissions where key = 'artists.manage'), '11a. artists.manage está en el catálogo');
  perform pg_temp.chk((select array_agg(r.key order by r.key) from public.role_permissions rp join public.roles r on r.id = rp.role_id where rp.permission_key = 'artists.manage') = array['admin', 'owner'], '11b. Solo owner y admin lo tienen por defecto');
end $$;

-- ---------------------------------------------------------------------------
-- 12. El avatar no cuenta en los resúmenes
-- ---------------------------------------------------------------------------
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1'); -- owner
do $$
declare
  before_photos bigint;
  v_asset uuid := gen_random_uuid();
begin
  select photos into before_photos from public.artist_summary('a1000000-0000-0000-0000-000000000001');
  reset role;
  insert into public.assets (id, kind, space, artist_id, original_filename, storage_key, status, visibility)
  values (v_asset, 'photo', 'workspace', 'a1000000-0000-0000-0000-000000000001', 'avatar.jpg', 'test/avatar-' || v_asset, 'ready', 'published');
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
  perform pg_temp.chk((select photos from public.artist_summary('a1000000-0000-0000-0000-000000000001')) = before_photos + 1, '12a. Una foto nueva cuenta como foto');
  reset role;
  update public.artists set avatar_asset_id = v_asset where id = 'a1000000-0000-0000-0000-000000000001';
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000000c1');
  perform pg_temp.chk((select photos from public.artist_summary('a1000000-0000-0000-0000-000000000001')) = before_photos, '12b. Si es el avatar del artista deja de contar como foto');
end $$;
reset role;

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

select 'ARTISTS OK' as resultado;
