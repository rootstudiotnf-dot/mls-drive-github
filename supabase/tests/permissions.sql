-- MLS Drive — pruebas del motor de permisos (Fase 2)
--
-- Cómo ejecutarlas: SQL Editor de Supabase (rol postgres) o `psql`, DESPUÉS de aplicar 0001 a 0007.
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
--
-- Cada caso imprime su resultado: un NOTICE «OK / FALLO <caso>» al ejecutarse y, justo antes del
-- ROLLBACK, una tabla con TODOS los casos (psql la muestra; en el SQL Editor mira Results/Notices).
-- Si algún caso falla, el script termina con un error que lista los casos que fallan.
-- Si todo va bien, el último resultado es «PERMISSIONS OK».

begin;

create temp table results (n serial primary key, ok boolean not null, label text not null);
grant insert, select on results to public;
grant usage on sequence results_n_seq to public;

-- Registra un caso (no aborta: así se ven todos los resultados de una vez).
create function pg_temp.chk(cond boolean, label text) returns void
language plpgsql as $$
begin
  insert into results (ok, label) values (coalesce(cond, false), label);
  raise notice '% %', case when coalesce(cond, false) then 'OK   ' else 'FALLO' end, label;
end $$;

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
create function pg_temp.act_as(uid uuid, aal text default 'aal2') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
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

-- Atajo: can_access del usuario autenticado actual.
create function pg_temp.ca(uid uuid, act text, typ text, rid uuid) returns boolean
language sql as $$ select public.can_access(uid, act, typ, rid) $$;

-- ---------------------------------------------------------------------------
-- Usuarios (una invitación pendiente por correo y luego el alta, como en la app)
-- ---------------------------------------------------------------------------
insert into public.invitations (email, role_id)
select v.email, r.id
from (values
  ('owner@t.local', 'owner'), ('admin@t.local', 'admin'), ('artist@t.local', 'artist'),
  ('artist2@t.local', 'artist'), ('photo@t.local', 'photographer'), ('collab@t.local', 'collaborator')
) as v(email, role_key) join public.roles r on r.key = v.role_key;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@t.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'artist@t.local'),
  ('00000000-0000-0000-0000-0000000000a4', 'artist2@t.local'),
  ('00000000-0000-0000-0000-0000000000a5', 'photo@t.local'),
  ('00000000-0000-0000-0000-0000000000a6', 'collab@t.local');

update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active';

-- Atajos de ids
create temp table u (name text primary key, id uuid);
insert into u values
  ('owner',  '00000000-0000-0000-0000-0000000000a1'),
  ('admin',  '00000000-0000-0000-0000-0000000000a2'),
  ('artist', '00000000-0000-0000-0000-0000000000a3'),
  ('artist2','00000000-0000-0000-0000-0000000000a4'),
  ('photo',  '00000000-0000-0000-0000-0000000000a5'),
  ('collab', '00000000-0000-0000-0000-0000000000a6');
grant select on u to authenticated;

-- ---------------------------------------------------------------------------
-- Contenido de prueba
-- ---------------------------------------------------------------------------
insert into public.artists (id, name, slug) values
  ('10000000-0000-0000-0000-00000000000a', 'Artista A', 'artista-a'),
  ('10000000-0000-0000-0000-00000000000b', 'Artista B', 'artista-b'),
  ('10000000-0000-0000-0000-00000000000c', 'Artista Borrado', 'artista-borrado');
update public.artists set deleted_at = now() where slug = 'artista-borrado';

insert into public.sessions (id, artist_id, name) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Sesión A1'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Sesión B1');
-- Fase 5: dentro de una sesión solo se descarga si la sesión lo permite (en los casos antiguos, sí)
update public.sessions set download_mode = 'original';

-- Carpeta raíz y subcarpeta (para probar la herencia de grants por ancestros)
insert into public.folders (id, artist_id, parent_id, name, kind) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000b', null, 'Raíz B', 'photos'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-000000000001', 'Sub B', 'photos');

-- Assets del artista A
insert into public.assets (id, kind, space, artist_id, session_id, original_filename, storage_key, visibility, downloadable, uploaded_by) values
  ('40000000-0000-0000-0000-000000000001', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'a.jpg',  'k1', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-000000000002', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a', 'p.jpg',  'k2', 'private',   true,  '00000000-0000-0000-0000-0000000000a5'),
  ('40000000-0000-0000-0000-000000000003', 'video',    'workspace', '10000000-0000-0000-0000-00000000000a', null, 'v.mp4', 'k3', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-000000000004', 'document', 'workspace', '10000000-0000-0000-0000-00000000000a', null, 'd.pdf', 'k4', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-000000000005', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000a', null, 'nd.jpg', 'k5', 'published', false, '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-000000000006', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000a', null, 'del.jpg','k6', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-000000000007', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000c', null, 'ab.jpg', 'k7', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  -- Artista B (carpeta Sub B)
  ('40000000-0000-0000-0000-000000000008', 'photo',    'workspace', '10000000-0000-0000-0000-00000000000b', null, 'b.jpg',  'k8', 'published', true,  '00000000-0000-0000-0000-0000000000a2'),
  -- Audio de los beats (biblioteca aparte)
  ('40000000-0000-0000-0000-00000000000a', 'audio',    'workspace', null, null, 'b1.wav', 'k10', 'published', true, '00000000-0000-0000-0000-0000000000a1'),
  ('40000000-0000-0000-0000-00000000000b', 'audio',    'workspace', null, null, 'b2.wav', 'k11', 'published', true, '00000000-0000-0000-0000-0000000000a1');
-- Vault (Fase 8): vive en una carpeta del Vault
insert into public.assets (id, kind, space, artist_id, folder_id, original_filename, storage_key, visibility, downloadable, uploaded_by)
select '40000000-0000-0000-0000-000000000009', 'document', 'vault', null, f.id, 'contrato.pdf', 'k9', 'published', true, '00000000-0000-0000-0000-0000000000a1'
from public.folders f where f.space = 'vault' and f.name = 'Documentos';
-- Desde la Fase 3 solo los assets 'ready' se ven con normalidad (los de subida/fallidos, solo quien los sube).
update public.assets set status = 'ready';
update public.assets set deleted_at = now() where id = '40000000-0000-0000-0000-000000000006';
update public.assets set folder_id = '30000000-0000-0000-0000-000000000002' where id = '40000000-0000-0000-0000-000000000008';

insert into public.beats (id, asset_id, title, status, downloadable, created_by) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-00000000000a', 'Beat publicado', 'published', true,  '00000000-0000-0000-0000-0000000000a1'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-00000000000b', 'Beat borrador',  'draft',     false, '00000000-0000-0000-0000-0000000000a1');

-- Asignaciones: artist, photo y collab están asignados al artista A; artist2 no.
insert into public.artist_members (artist_id, user_id)
select '10000000-0000-0000-0000-00000000000a', id from u where name in ('artist', 'photo', 'collab');

-- ---------------------------------------------------------------------------
-- 0. Catálogo y siembra
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.chk((select count(*) from public.permissions) = 38, '0a. El catálogo tiene 38 permisos (5 áreas × 6 + 5 de administración + 3 de comentar)');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'owner') = 38, '0b. owner: todo');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'admin') = 31, '0c. admin: todo menos vault.* y roles.manage (31)');
  perform pg_temp.chk(not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
                     where r.key = 'admin' and (rp.permission_key like 'vault.%' or rp.permission_key = 'roles.manage')), '0d. admin sin vault ni roles.manage');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'artist') = 9, '0e. artist: 9 permisos');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'photographer') = 3, '0f. photographer: 3 permisos');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'collaborator') = 3, '0g. collaborator: 3 permisos');
  perform pg_temp.chk((select scope from public.roles where key = 'owner') = 'all' and (select scope from public.roles where key = 'admin') = 'all'
     and (select scope from public.roles where key = 'artist') = 'assigned', '0h. scope: owner/admin all; artist assigned');
  perform pg_temp.chk((select is_locked from public.roles where key = 'owner') and not (select is_locked from public.roles where key = 'admin'), '0i. Solo el owner está bloqueado');
end $$;

-- ---------------------------------------------------------------------------
-- 1. Owner
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '1a. owner ve un asset');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '1b. owner ve el Vault sin grant');
  perform pg_temp.chk(public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000009'), '1c. owner elimina en el Vault');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'vault', null), '1d. owner accede al Vault');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'beat', '50000000-0000-0000-0000-000000000002'), '1e. owner ve beats en borrador');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000005'), '1f. Descarga denegada si downloadable = false (incluso owner)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000006'), '1g. Un asset borrado (lógico) no se ve ni siquiera el owner');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000007'), '1h. Los assets de un artista borrado desaparecen');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000c'), '1i. Un artista borrado no se ve');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', gen_random_uuid()), '1j. Un recurso inexistente se deniega');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'cosa-rara', gen_random_uuid()), '1k. Tipo de recurso desconocido: denegado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'comer', 'asset', '40000000-0000-0000-0000-000000000001'), '1l. Acción desconocida: denegada');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 2. Admin: todo menos Vault
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '2a. admin ve fotos (scope all)');
  perform pg_temp.chk(public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000003'), '2b. admin edita vídeos');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000b'), '2c. admin ve cualquier artista sin asignación');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'beat', '50000000-0000-0000-0000-000000000002'), '2d. admin ve beats en borrador (tiene edit)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '2e. admin NO ve el Vault (sin vault.view)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null), '2f. admin NO accede al Vault');
  perform pg_temp.chk(public.has_permission(auth.uid(), 'users.invite') and public.has_permission(auth.uid(), 'access.manage'), '2g. admin invita y gestiona accesos');
  perform pg_temp.chk(not public.has_permission(auth.uid(), 'roles.manage'), '2h. admin NO gestiona roles');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Artist asignado al artista A (scope assigned)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '3a. artist asignado ve foto publicada');
  perform pg_temp.chk(public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000001'), '3b. artist descarga foto downloadable');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000003'), '3c. artist ve vídeos');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000004'), '3d. artist ve documentos (files)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000005'), '3e. artist: downloadable=false bloquea la descarga');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000005'), '3f. ...pero sí la vista');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'upload', 'session', '20000000-0000-0000-0000-00000000000a'), '3g. artist NO sube (sin permiso en el rol)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000001'), '3h. artist NO edita');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000002'), '3i. artist NO ve fotos privadas ajenas (sin edit/publish)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000008'), '3j. artist NO ve contenido de un artista no asignado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000b'), '3k. artist NO ve artistas no asignados');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000a'), '3l. artist ve su artista');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'session', '20000000-0000-0000-0000-00000000000a'), '3m. artist ve sesiones de su artista');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '3n. artist NO ve el Vault');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'beat', '50000000-0000-0000-0000-000000000001'), '3o. Beats son biblioteca aparte: sin grant de beat, un rol assigned no los ve');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000006'), '3p. Un asset borrado no se ve');
  -- Un usuario NO puede preguntar por el acceso de otro
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000a1', 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '3q. Consultar el acceso de otro usuario devuelve false (no se sondea a terceros)');
  perform pg_temp.chk(not public.has_permission('00000000-0000-0000-0000-0000000000a1', 'photos.view'), '3r. Ni sus permisos');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 4. Grants: dónde, nunca más allá del rol
-- ---------------------------------------------------------------------------
-- artist2 (no asignado) → sin acceso
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$
begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4a. Sin asignación ni grant: denegado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000a'), '4b. Sin asignación: no ve el artista');
end $$;
reset role;

-- grant de sesión (view) → ve el asset de esa sesión pero no uno de otra parte
insert into public.grants (user_id, resource_type, resource_id, can_view)
values ('00000000-0000-0000-0000-0000000000a4', 'session', '20000000-0000-0000-0000-00000000000a', true);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4c. Grant en la sesión: ve el asset de la sesión (herencia)');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'session', '20000000-0000-0000-0000-00000000000a'), '4d. ...y la propia sesión');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000003'), '4e. ...pero no un asset fuera de la sesión');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000001'), '4f. El flag can_download=false no concede descarga');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'artist', '10000000-0000-0000-0000-00000000000a'), '4g. Grant de sesión no concede el artista');
end $$;
reset role;

-- El rol es el techo: grant de edición a un artist, pero el rol no tiene photos.edit
update public.grants set can_edit = true, can_download = true, can_upload = true
where user_id = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000001'), '4h. Con can_download y rol con photos.download: descarga');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000001'), '4i. EL ROL ES EL TECHO: can_edit no concede lo que el rol no permite');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'upload', 'session', '20000000-0000-0000-0000-00000000000a'), '4j. Ni subir');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000001'), '4k. Ni eliminar');
end $$;
reset role;

-- caducado y revocado
update public.grants set expires_at = now() - interval '1 minute' where user_id = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4l. Grant caducado: denegado');
end $$;
reset role;
update public.grants set expires_at = now() + interval '1 day' where user_id = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4m. Grant con caducidad futura: permitido');
end $$;
reset role;
update public.grants set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a4';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4n. Grant revocado: denegado');
end $$;
reset role;

-- Herencia por carpetas: grant en la carpeta raíz → ve el asset de la subcarpeta
insert into public.grants (user_id, resource_type, resource_id, can_view)
values ('00000000-0000-0000-0000-0000000000a4', 'folder', '30000000-0000-0000-0000-000000000001', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000008'), '4o. Grant en carpeta raíz: ve el asset de la subcarpeta (ancestros)');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'folder', '30000000-0000-0000-0000-000000000002'), '4p. ...y la subcarpeta');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '4q. ...pero no otros assets');
end $$;
reset role;

-- Grant de beat para un rol assigned
insert into public.grants (user_id, resource_type, resource_id, can_view, can_download)
values ('00000000-0000-0000-0000-0000000000a3', 'beat', '50000000-0000-0000-0000-000000000001', true, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'beat', '50000000-0000-0000-0000-000000000001'), '4r. artist con grant de beat ve el beat publicado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'beat', '50000000-0000-0000-0000-000000000001'), '4s. ...pero el rol artist no tiene beats.download (techo)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'beat', '50000000-0000-0000-0000-000000000002'), '4t. ...ni ve otro beat sin grant');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 5. Photographer y collaborator
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000002'), '5a. photographer ve lo que él subió (privado)');
  perform pg_temp.chk(public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000002'), '5b. photographer edita fotos');
  perform pg_temp.chk(public.can_access(auth.uid(), 'upload', 'session', '20000000-0000-0000-0000-00000000000a'), '5c. photographer sube a la sesión');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000005'), '5d. photographer ve fotos publicadas');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000003'), '5e. photographer NO ve vídeos');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000002'), '5f. photographer NO elimina');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000001'), '5g. photographer NO descarga');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'upload', 'session', '20000000-0000-0000-0000-00000000000b'), '5h. photographer NO sube a artistas no asignados');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a6');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '5i. collaborator ve fotos');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000004'), '5j. collaborator ve archivos');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000002'), '5k. collaborator NO ve privados ajenos');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000001'), '5l. collaborator NO descarga');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 6. Vault: rol + grant explícito de tipo 'vault'; no hereda
-- ---------------------------------------------------------------------------
-- Rol personalizado con permisos de vault y scope 'all'
insert into public.roles (key, name, scope) values ('vaultero', 'Vaultero', 'all');
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['vault.view','vault.download','photos.view']) k where r.key = 'vaultero';

insert into public.invitations (email, role_id) select 'vault@t.local', id from public.roles where key = 'vaultero';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a7', 'vault@t.local');
update public.invitations set status = 'accepted' where email = 'vault@t.local';
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a7';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$
begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '6a. Con vault.view pero SIN grant de vault: denegado');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null), '6b. Ni el espacio Vault');
end $$;
reset role;

-- Un grant de ARTISTA no abre el Vault
insert into public.grants (user_id, resource_type, resource_id, can_view, can_download)
values ('00000000-0000-0000-0000-0000000000a7', 'artist', '10000000-0000-0000-0000-00000000000a', true, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '6c. El Vault NO hereda de grants de artista');
end $$;
reset role;

insert into public.grants (user_id, resource_type, resource_id, can_view, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'vault', null, true, now() + interval '30 days');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$
begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '6d. Rol con vault.view + grant de vault: ve el asset del Vault');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'vault', null), '6e. ...y el espacio Vault');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000009'), '6f. El grant solo tiene can_view: no descarga');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000009'), '6g. El rol no tiene vault.edit: no edita');
end $$;
reset role;

-- Un grant de vault a un rol SIN permisos de vault no sirve (techo del rol)
insert into public.grants (user_id, resource_type, resource_id, can_view, expires_at)
values ('00000000-0000-0000-0000-0000000000a6', 'vault', null, true, now() + interval '30 days');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a6');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '6h. collaborator con grant de vault pero sin vault.view: denegado (techo)');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7. Usuario desactivado
-- ---------------------------------------------------------------------------
update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a3';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$
begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '7a. Usuario desactivado: sin acceso');
  perform pg_temp.chk(not public.has_permission(auth.uid(), 'photos.view'), '7b. Usuario desactivado: sin permisos');
end $$;
reset role;
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a3';

-- ---------------------------------------------------------------------------
-- 8. RLS de las tablas nuevas
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); -- artist asignado a A, con grant de beat
do $$
begin
  perform pg_temp.chk((select count(*) from public.artists) = 1, '8a. artist solo lee su artista (RLS)');
end $$;
do $$
declare n int;
begin
  select count(*) into n from public.assets;
  -- visibles: 1 (foto pub), 3 (vídeo), 4 (doc), 5 (foto no descargable) = 4
  perform pg_temp.chk(n = 5, '8b. artist lee exactamente los 5 assets permitidos (4 + el audio del beat con grant, autorizado a través del beat — Fase 7) (leyó ' || n || ')');
  perform pg_temp.chk((select count(*) from public.sessions) = 1, '8c. artist lee su sesión');
  perform pg_temp.chk((select count(*) from public.beats) = 1, '8d. artist lee solo el beat con grant');
  perform pg_temp.chk((select count(*) from public.grants) = 1, '8e. artist lee solo sus grants');
  perform pg_temp.chk((select count(*) from public.artist_members) = 1, '8f. artist lee solo sus asignaciones');
  perform pg_temp.chk((select count(*) from public.activity_log) = 0, '8g. artist no lee la auditoría');
  perform pg_temp.chk((select count(*) from public.role_permissions) = 9, '8h. artist lee solo los permisos de su rol');
  perform pg_temp.chk((select count(*) from public.permissions) = 38, '8i. artist lee el catálogo de permisos');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); -- admin: access.manage
do $$
begin
  perform pg_temp.chk((select count(*) from public.grants) >= 4, '8j. admin (access.manage) lee todos los grants');
  perform pg_temp.chk((select count(*) from public.artist_members) = 3, '8k. admin lee todas las asignaciones');
  perform pg_temp.chk((select count(*) from public.role_permissions) = 31, '8l. admin lee solo los permisos de su rol (no tiene roles.manage)');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); -- owner: roles.manage
do $$
begin
  perform pg_temp.chk((select count(*) from public.role_permissions) > 34, '8m. owner (roles.manage) lee los permisos de todos los roles');
end $$;
reset role;

-- Nadie escribe desde el cliente
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); -- ni el owner
do $$
begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.artists (name, slug) values ('X', 'x') $q$) = '42501', '8n. owner NO inserta artistas desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' $q$) = '42501', '8o. owner NO actualiza assets desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, can_view) values (auth.uid(), 'vault', true) $q$) = '42501', '8p. owner NO crea grants desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.role_permissions (role_id, permission_key) select id, 'photos.view' from public.roles limit 1 $q$) = '42501', '8q. owner NO toca role_permissions desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.activity_log (action) values ('x') $q$) = '42501', '8r. Nadie inserta en activity_log desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.replace_role_permissions(id, array['photos.view']) from public.roles limit 1 $q$) = '42501', '8s. replace_role_permissions no es invocable por usuarios');
end $$;
reset role;

set local role anon;
do $$
begin
  perform pg_temp.chk(pg_temp.sqlstate_of('select * from public.assets') = '42501', '8t. anon no lee assets');
  perform pg_temp.chk(pg_temp.sqlstate_of('select * from public.permissions') = '42501', '8u. anon no lee permissions');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.can_access(gen_random_uuid(), 'view', 'asset', gen_random_uuid()) $q$) = '42501', '8v. anon no ejecuta can_access');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 9. Integridad (aplica incluso al service role / postgres)
-- ---------------------------------------------------------------------------
do $$
begin
  -- activity_log: solo inserción
  insert into public.activity_log (actor_id, action, resource_type, metadata)
  values ('00000000-0000-0000-0000-0000000000a1', 'test', 'asset', '{"ok":true}');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.activity_log set action = 'x' $q$) = 'P0001', '9a. activity_log no se actualiza');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.activity_log $q$) = 'P0001', '9b. activity_log no se borra');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ truncate public.activity_log $q$) = 'P0001', '9c. activity_log no se vacía');

  -- rol bloqueado
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.roles set name = 'Dueño' where key = 'owner' $q$) = 'P0001', '9d. El owner no se modifica');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.roles where key = 'owner' $q$) = 'P0001', '9e. El owner no se elimina');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.role_permissions where role_id = (select id from public.roles where key = 'owner') $q$) = 'P0001', '9f. No se quitan permisos al owner');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.replace_role_permissions((select id from public.roles where key = 'owner'), array['photos.view']) $q$) = 'P0001', '9g. replace_role_permissions respeta el bloqueo');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.roles set is_locked = true where key = 'admin' $q$) = 'P0001', '9h. No se puede bloquear otro rol');

  -- replace_role_permissions en un rol normal
  perform public.replace_role_permissions((select id from public.roles where key = 'collaborator'), array['photos.view', 'photos.view', 'files.view']);
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'collaborator') = 2, '9i. replace_role_permissions reemplaza y deduplica');

  -- grants: vault sin recurso y el resto con recurso
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, resource_id, can_view) values ('00000000-0000-0000-0000-0000000000a3', 'vault', gen_random_uuid(), true) $q$) = '23514', '9j. Un grant de vault no lleva resource_id');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, can_view) values ('00000000-0000-0000-0000-0000000000a3', 'artist', true) $q$) = '23514', '9k. Un grant que no es de vault exige resource_id');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, resource_id, can_view) values ('00000000-0000-0000-0000-0000000000a3', 'beat', '50000000-0000-0000-0000-000000000001', true) $q$) = '23505', '9l. Un único grant vigente por usuario y recurso');

  -- catálogo
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.role_permissions (role_id, permission_key) select id, 'inventado.todo' from public.roles where key = 'artist' $q$) = '23503', '9m. No se pueden asignar permisos que no existen en el catálogo');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.roles (key, name) values ('otro', 'ARTIST') $q$) = '23505', '9n. Los nombres de rol son únicos (sin distinguir mayúsculas)');
end $$;

-- ---------------------------------------------------------------------------
-- 10. Publicar y eliminar (acciones con permiso propio; los grants las habilitan con can_edit)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); -- owner
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000001'), '10a. owner publica');
  perform pg_temp.chk(public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000001'), '10b. owner elimina');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); -- admin
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000001'), '10c. admin publica fotos');
  perform pg_temp.chk(public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000003'), '10d. admin elimina vídeos');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000009'), '10e. admin NO publica en el Vault');
  perform pg_temp.chk(public.can_access(auth.uid(), 'upload', 'session', '20000000-0000-0000-0000-00000000000a'), '10f. admin sube a cualquier sesión (scope all)');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5'); -- photographer
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000002'), '10g. photographer NO publica (ni siquiera lo suyo)');
end $$;
reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3'); -- artist asignado
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000001'), '10h. artist NO publica');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000001'), '10i. artist NO elimina');
end $$;
reset role;

-- grant con can_edit a un artist no asignado: el rol no tiene edit/publish/delete → sigue denegado (techo)
insert into public.grants (user_id, resource_type, resource_id, can_view, can_edit)
values ('00000000-0000-0000-0000-0000000000a4', 'artist', '10000000-0000-0000-0000-00000000000a', true, true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000001'), '10j. grant de artista: artist2 ve el contenido de ese artista');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'publish', 'asset', '40000000-0000-0000-0000-000000000001'), '10k. ...pero can_edit no le da publicar (techo del rol)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000001'), '10l. ...ni eliminar');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 11. activity_log registra las publicaciones (lo hace la base de datos, venga de donde venga)
-- ---------------------------------------------------------------------------
do $$
declare
  n_before int;
begin
  -- Sin sesión (como el service role): se borran los claims que dejaron las simulaciones anteriores.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.actor_id', '00000000-0000-0000-0000-0000000000a2', true);

  update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-000000000002';
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.published'
      and resource_id = '40000000-0000-0000-0000-000000000002'
      and actor_id = '00000000-0000-0000-0000-0000000000a2'), '11a. Publicar un asset queda registrado con su autor');

  update public.assets set visibility = 'private' where id = '40000000-0000-0000-0000-000000000002';
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.unpublished'
      and resource_id = '40000000-0000-0000-0000-000000000002'), '11b. Despublicar también');

  select count(*) into n_before from public.activity_log where resource_id = '40000000-0000-0000-0000-000000000002';
  update public.assets set title = 'otro título' where id = '40000000-0000-0000-0000-000000000002';
  perform pg_temp.chk((select count(*) from public.activity_log where resource_id = '40000000-0000-0000-0000-000000000002') = n_before,
    '11c. Cambios que no son de publicación no generan entrada');

  -- Fase 7: para publicar un beat hacen falta datos completos y el preview listo
  insert into public.genres (name) values ('Test') on conflict do nothing;
  update public.beats set bpm = 120, musical_key = 'Am', genre_id = (select id from public.genres where name = 'Test') where id = '50000000-0000-0000-0000-000000000002';
  insert into public.media_jobs (asset_id, kind, status) values ('40000000-0000-0000-0000-00000000000b', 'audio', 'ready');
  update public.beats set status = 'published' where id = '50000000-0000-0000-0000-000000000002';
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'beat.published'
      and resource_id = '50000000-0000-0000-0000-000000000002'), '11d. Publicar un beat queda registrado');

  insert into public.assets (id, kind, original_filename, storage_key, visibility, uploaded_by)
  values ('40000000-0000-0000-0000-0000000000ff', 'photo', 'nuevo.jpg', 'k-nuevo', 'published', '00000000-0000-0000-0000-0000000000a5');
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.published'
      and resource_id = '40000000-0000-0000-0000-0000000000ff'), '11e. Crear un asset ya publicado también se registra');

  perform set_config('app.actor_id', '', true);
  update public.assets set visibility = 'private' where id = '40000000-0000-0000-0000-0000000000ff';
  perform pg_temp.chk(exists (select 1 from public.activity_log where action = 'asset.unpublished'
      and resource_id = '40000000-0000-0000-0000-0000000000ff' and actor_id is null), '11f. Sin actor conocido se registra igualmente (actor nulo)');
end $$;

-- Cambios de roles y grants: los registran las acciones de servidor (logActivity); aquí se comprueba que
-- la tabla admite esas entradas y que el rastro es inalterable.
do $$
begin
  insert into public.activity_log (actor_id, action, resource_type, resource_id, metadata)
  values ('00000000-0000-0000-0000-0000000000a1', 'role.updated', 'role', gen_random_uuid(), '{"added":["photos.view"]}'),
         ('00000000-0000-0000-0000-0000000000a2', 'grant.revoked', 'artist', gen_random_uuid(), '{}');
  perform pg_temp.chk((select count(*) from public.activity_log where action in ('role.updated', 'grant.revoked')) = 2, '11g. Se admiten entradas role.* y grant.*');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.activity_log set actor_id = null where action = 'role.updated' $q$) = 'P0001', '11h. ...y no se pueden alterar');
end $$;

-- ---------------------------------------------------------------------------
-- 12. El sistema siempre conserva a su owner
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a1' $q$) = 'P0001',
    '12a. No se puede borrar el perfil del owner activo');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a1' $q$) = 'P0001',
    '12b. Ni desactivarlo');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.profiles set role_id = (select id from public.roles where key = 'admin') where id = '00000000-0000-0000-0000-0000000000a1' $q$) = 'P0001',
    '12c. Ni degradarlo');
end $$;

-- Un owner aún sin aceptar (disabled) sí puede recrearse: lo usa `npm run create-owner`.
insert into public.invitations (email, role_id) select 'owner2@t.local', id from public.roles where key = 'owner';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a8', 'owner2@t.local');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a8' $q$) is null,
    '12d. Un owner pendiente de aceptar puede recrearse');
end $$;

-- ---------------------------------------------------------------------------
-- 13. Fase 4 — publicación, mover entre artistas, revocación y papelera
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '', true); end $$;

-- Publicación: la foto privada del photographer no la ve el artist hasta que se publica
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000002') = 0, '13a. Lo subido sin permiso de publicar (private) no lo ve el artist');
end $$;
reset role;
update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-000000000002';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000002') = 1, '13b. Tras publicar, el artist lo ve');
  perform pg_temp.chk(public.can_access(auth.uid(), 'download', 'asset', '40000000-0000-0000-0000-000000000002'), '13c. ...y puede descargarlo si es downloadable');
end $$;
reset role;
update public.assets set visibility = 'private' where id = '40000000-0000-0000-0000-000000000002';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000002') = 0, '13d. Al despublicar deja de verlo al instante');
end $$;
reset role;

-- Papelera: un asset borrado no lo ve nadie; al restaurarlo vuelve
update public.assets set deleted_at = now() where id = '40000000-0000-0000-0000-000000000001';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 0, '13e. En la papelera: el artist no lo ve');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 0, '13f. En la papelera: tampoco el admin por RLS (se gestiona desde servidor)');
end $$;
reset role;
update public.assets set deleted_at = null where id = '40000000-0000-0000-0000-000000000001';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 1, '13g. Restaurado: vuelve a verse');
end $$;
reset role;

-- Mover entre artistas: quien solo está asignado al origen pierde el acceso; la clave no cambia
do $$
declare v_key text;
begin
  select storage_key into v_key from public.assets where id = '40000000-0000-0000-0000-000000000001';
  update public.assets set artist_id = '10000000-0000-0000-0000-00000000000b' where id = '40000000-0000-0000-0000-000000000001';
  perform pg_temp.chk((select storage_key from public.assets where id = '40000000-0000-0000-0000-000000000001') = v_key, '13h. Mover entre artistas no cambia la storage_key');
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 0, '13i. El artist asignado al origen (A) ya no ve el asset movido a B');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 1, '13j. El admin (scope all) sí lo ve en B');
end $$;
reset role;

-- Revocación: con un grant de artista, el acceso desaparece al revocarlo
insert into public.grants (user_id, resource_type, resource_id, can_view)
values ('00000000-0000-0000-0000-0000000000a4', 'artist', '10000000-0000-0000-0000-00000000000b', true)
on conflict do nothing;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 1, '13k. Con grant vigente sobre el artista B, artist2 ve su contenido publicado');
end $$;
reset role;
update public.grants set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a4' and resource_type = 'artist' and resource_id = '10000000-0000-0000-0000-00000000000b';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000001') = 0, '13l. Al revocar el grant, el contenido deja de ser visible de inmediato');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 14. Fase 5 — sesiones: participantes, modos de descarga y favoritas
--     (usuarios propios: pa = artista A, pb = artista B, pe = photographer, pc = collaborator)
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario
-- Usuarios propios de esta sección: pa (artist, artista A), pb (artist, artista B), pe (photographer, A), pc (collaborator, A)
insert into public.invitations (email, role_id)
select v.email, r.id from (values ('pa@t.local','artist'),('pb@t.local','artist'),('pe@t.local','photographer'),('pc@t.local','collaborator')) as v(email, role_key)
join public.roles r on r.key = v.role_key;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'pa@t.local'), ('00000000-0000-0000-0000-0000000000b2', 'pb@t.local'),
  ('00000000-0000-0000-0000-0000000000b3', 'pe@t.local'), ('00000000-0000-0000-0000-0000000000b4', 'pc@t.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active' where email in ('pa@t.local','pb@t.local','pe@t.local','pc@t.local');
insert into public.artist_members (artist_id, user_id) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b1'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b3'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000b4'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b2');
-- Los casos anteriores editan roles: se restauran los permisos de serie de artist y photographer
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['photos.view','photos.download','videos.view','videos.download','files.view','files.download','beats.view']) k where r.key = 'artist'
on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['photos.view','photos.upload','photos.edit']) k where r.key = 'photographer'
on conflict do nothing;
-- Sesión y fotos propias de esta sección (los casos anteriores mueven y cambian los assets del fixture)
insert into public.sessions (id, artist_id, name, download_mode) values
  ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-00000000000a', 'Sesión de la fase 5', 'off');
insert into public.assets (id, kind, space, artist_id, session_id, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('40000000-0000-0000-0000-0000000000f1', 'photo', 'workspace', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000f1', 's1.jpg', 'k-s1', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-0000000000f2', 'photo', 'workspace', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000f1', 's2.jpg', 'k-s2', 'ready', 'private',   true, '00000000-0000-0000-0000-0000000000a2'),
  ('40000000-0000-0000-0000-0000000000f3', 'video', 'workspace', '10000000-0000-0000-0000-00000000000a', null, 's3.mp4', 'k-s3', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000a2');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14a. Sin ser participante, artist2 no ve las fotos de la sesión del artista A');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'session', '20000000-0000-0000-0000-0000000000f1'), '14b. Ni la propia sesión');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario

insert into public.session_participants (session_id, artist_id) values
  ('20000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-00000000000b');
insert into public.folders (id, artist_id, session_id, name, kind) values
  ('30000000-0000-0000-0000-0000000000f1', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000f1', 'Selección', 'photos');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'session', '20000000-0000-0000-0000-0000000000f1'), '14c. Como participante, artist2 ve la sesión');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14d. Y sus fotos publicadas');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'asset', '40000000-0000-0000-0000-0000000000f2'), '14e. Pero no las privadas');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'asset', '40000000-0000-0000-0000-0000000000f3'), '14f. Ni material del artista A fuera de la sesión');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'artist', '10000000-0000-0000-0000-00000000000a'), '14g. Participar no da acceso al artista A');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'folder', '30000000-0000-0000-0000-0000000000f1'), '14h. Las carpetas de la sesión heredan el acceso');
  perform pg_temp.chk((select count(*) from public.assets where session_id = '20000000-0000-0000-0000-0000000000f1') = 1, '14i. RLS: lista solo la foto publicada de la sesión');
  perform pg_temp.chk((select count(*) from public.sessions where id = '20000000-0000-0000-0000-0000000000f1') = 1, '14j. RLS: lee la sesión');
  perform pg_temp.chk((select count(*) from public.session_participants) = 1, '14k. RLS: lee los participantes de sesiones visibles');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'edit', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14l. El rol sigue siendo el techo (artist no edita)');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario

-- Modos de descarga (por defecto 'off')
do $$ begin
  perform pg_temp.chk((select download_mode::text from public.sessions where id = '20000000-0000-0000-0000-0000000000f1') = 'off', '14m. download_mode por defecto: off');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14n. Con modo off no se descarga (artist)');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000a1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14o. Con modo off ni siquiera el owner descarga dentro de la sesión');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f3'), '14p. El modo no afecta a lo que está fuera de la sesión');
end $$;
update public.sessions set download_mode = 'web' where id = '20000000-0000-0000-0000-0000000000f1';
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14q. Con modo web se descarga (artist)');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b2', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14r. También el participante');
end $$;
update public.sessions set download_mode = 'original' where id = '20000000-0000-0000-0000-0000000000f1';
update public.assets set downloadable = false where id = '40000000-0000-0000-0000-0000000000f1';
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14s. Aunque el modo sea original, el asset debe ser downloadable');
end $$;
update public.assets set downloadable = true where id = '40000000-0000-0000-0000-0000000000f1';
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000b1', 'download', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14t. Modo original + downloadable: se descarga');
end $$;

-- Favoritas: se escriben desde el servidor; cada cual lee las suyas, y quien edita/publica lee las del artista
insert into public.favorites (user_id, asset_id) values
  ('00000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000b2', '40000000-0000-0000-0000-0000000000f1');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.favorites) = 1 and (select user_id from public.favorites) = '00000000-0000-0000-0000-0000000000b1', '14u. artist solo lee sus favoritas');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.favorites (user_id, asset_id) values ('00000000-0000-0000-0000-0000000000b1', '40000000-0000-0000-0000-0000000000f2') $q$) = '42501', '14v. Los clientes no escriben favoritas (permiso denegado)');
  perform pg_temp.chk((select count(*) from public.session_favorites('20000000-0000-0000-0000-0000000000f1')) = 1, '14w. session_favorites respeta RLS (solo las propias)');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.favorites) = 1 and (select user_id from public.favorites) = '00000000-0000-0000-0000-0000000000b2', '14x. artist2 no ve las favoritas de artist');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.favorites) = 2, '14y. photographer (photos.edit sobre el artista) lee las de todos');
  perform pg_temp.chk((select count(*) from public.session_favorites('20000000-0000-0000-0000-0000000000f1')) = 2, '14z. session_favorites devuelve las de todos para quien edita');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b4'); -- collab: ve pero no edita
do $$ begin
  perform pg_temp.chk((select count(*) from public.favorites) = 0, '14za. collab (sin editar/publicar) no ve favoritas ajenas');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario

-- Orden manual, resúmenes y carpetas
do $$ begin
  perform pg_temp.chk(public.set_session_order('20000000-0000-0000-0000-0000000000f1', array['40000000-0000-0000-0000-0000000000f2'::uuid, '40000000-0000-0000-0000-0000000000f1'::uuid, '40000000-0000-0000-0000-000000000008'::uuid]) = 2, '14zb. set_session_order solo ordena assets de esa sesión');
  perform pg_temp.chk((select sort_index from public.assets where id = '40000000-0000-0000-0000-0000000000f2') = 0 and (select sort_index from public.assets where id = '40000000-0000-0000-0000-0000000000f1') = 1, '14zc. El orden queda guardado (índice = posición)');
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.set_session_order('20000000-0000-0000-0000-0000000000f1', array[]::uuid[]) $q$) = '42501', '14zd. Un cliente no puede reordenar');
  perform pg_temp.chk((select photos from public.session_counts() where session_id = '20000000-0000-0000-0000-0000000000f1') = 1, '14ze. session_counts: el artista cuenta solo lo publicado');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario
do $$ begin
  perform pg_temp.chk((select photos from public.session_counts() where session_id = '20000000-0000-0000-0000-0000000000f1') = 2, '14zf. session_counts (sin RLS): cuenta todas las fotos listas');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set avg_color = 'rojo' where id = '40000000-0000-0000-0000-0000000000f1' $q$) = '23514', '14zg. avg_color solo admite #rrggbb');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set avg_color = '#1a2b3c' where id = '40000000-0000-0000-0000-0000000000f1' $q$) is null, '14zh. avg_color válido');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.folders (artist_id, session_id, name, kind) values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000f1', 'selección', 'photos') $q$) = '23505', '14zi. Nombre de carpeta único dentro de la sesión');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.sessions (id, artist_id, name) values ('20000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'Sesión A2') $q$) is null, '14zj. Nueva sesión (download_mode off por defecto)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.folders (artist_id, session_id, name, kind) values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a2', 'Selección', 'photos') $q$) is null, '14zk. El mismo nombre sí vale en otra sesión');
  perform pg_temp.chk(exists (select 1 from public.folders where artist_id = '10000000-0000-0000-0000-00000000000a' and name = 'Fotos' and session_id is null), '14zl. Las carpetas base del artista siguen existiendo');
end $$;

-- Dejar de participar corta el acceso
delete from public.session_participants where session_id = '20000000-0000-0000-0000-0000000000f1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000b2');
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000b2', 'view', 'asset', '40000000-0000-0000-0000-0000000000f1'), '14zm. Al quitar la participación, artist2 pierde el acceso');
end $$;
reset role;
select set_config('request.jwt.claims', '', true); -- como service role: sin identidad de usuario

-- ---------------------------------------------------------------------------
-- 15. Fase 6 — vídeo: permisos de comentar, regla de publicación, trabajos y comentarios
--     (usuarios propios: v1 = artist de A, v2 = artist de B, v3 = rol «cineasta» sin comentar, v4 = admin)
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.roles (key, name, scope, description) values ('cineasta', 'Cineasta', 'assigned', 'Ve y sube vídeos, sin comentar');
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['videos.view', 'videos.upload', 'videos.edit']) k where r.key = 'cineasta';
insert into public.invitations (email, role_id)
select v.email, r.id from (values ('v1@t.local','artist'),('v2@t.local','artist'),('v3@t.local','cineasta'),('v4@t.local','admin')) as v(email, role_key)
join public.roles r on r.key = v.role_key;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'v1@t.local'), ('00000000-0000-0000-0000-0000000000d2', 'v2@t.local'),
  ('00000000-0000-0000-0000-0000000000d3', 'v3@t.local'), ('00000000-0000-0000-0000-0000000000d4', 'v4@t.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active' where email in ('v1@t.local','v2@t.local','v3@t.local','v4@t.local');
insert into public.artist_members (artist_id, user_id) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d1'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000d2'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000d3');
-- Los casos anteriores editan roles: se restauran los permisos de serie del artist
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['photos.view','videos.view','videos.download','files.view','beats.view','videos.comment','beats.comment']) k where r.key = 'artist'
on conflict do nothing;

insert into public.assets (id, kind, space, artist_id, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('40000000-0000-0000-0000-0000000000e1', 'video', 'workspace', '10000000-0000-0000-0000-00000000000a', 'v-pub.mp4',  'k-v1', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000d4'),
  ('40000000-0000-0000-0000-0000000000e2', 'video', 'workspace', '10000000-0000-0000-0000-00000000000a', 'v-priv.mp4', 'k-v2', 'ready', 'private',   true, '00000000-0000-0000-0000-0000000000d4'),
  ('40000000-0000-0000-0000-0000000000e3', 'photo', 'workspace', '10000000-0000-0000-0000-00000000000a', 'f.jpg',      'k-v3', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000d4');

do $$ begin
  perform pg_temp.chk((select count(*) from public.permissions where action = 'comment') = 3, '15a. El catálogo tiene los 3 permisos de comentar');
  perform pg_temp.chk((select array_agg(rp.permission_key order by rp.permission_key) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'artist' and rp.permission_key like '%.comment') = array['beats.comment','videos.comment'], '15b. artist: comenta vídeos y beats (no fotos)');
  perform pg_temp.chk((select count(*) from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'admin' and rp.permission_key like '%.comment') = 3, '15c. admin: los tres');
  perform pg_temp.chk(public.can_comment('00000000-0000-0000-0000-0000000000d1', '40000000-0000-0000-0000-0000000000e1'), '15d. Artista asignado comenta un vídeo publicado');
  perform pg_temp.chk(not public.can_comment('00000000-0000-0000-0000-0000000000d1', '40000000-0000-0000-0000-0000000000e2'), '15e. No comenta un vídeo privado (no lo ve)');
  perform pg_temp.chk(not public.can_comment('00000000-0000-0000-0000-0000000000d1', '40000000-0000-0000-0000-0000000000e3'), '15f. Sin photos.comment no comenta fotos');
  perform pg_temp.chk(not public.can_comment('00000000-0000-0000-0000-0000000000d2', '40000000-0000-0000-0000-0000000000e1'), '15g. Artista de otro artista no comenta');
  perform pg_temp.chk(not public.can_comment('00000000-0000-0000-0000-0000000000d3', '40000000-0000-0000-0000-0000000000e1'), '15h. Rol sin videos.comment no comenta aunque vea el vídeo');
  perform pg_temp.chk(public.can_comment('00000000-0000-0000-0000-0000000000d4', '40000000-0000-0000-0000-0000000000e2'), '15i. admin comenta incluso un vídeo privado');
end $$;

-- Regla de publicación
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-0000000000e2' $q$) = 'P0001', '15j. Un vídeo sin trabajo no se puede publicar');
  insert into public.media_jobs (asset_id, status) values ('40000000-0000-0000-0000-0000000000e2', 'failed');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-0000000000e2' $q$) = 'P0001', '15k. Con el trabajo en error tampoco');
  insert into public.media_jobs (asset_id, status) values ('40000000-0000-0000-0000-0000000000e2', 'processing');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-0000000000e2' $q$) = 'P0001', '15l. Ni mientras se procesa');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.media_jobs (asset_id, status) values ('40000000-0000-0000-0000-0000000000e2', 'queued') $q$) = '23505', '15m. Un solo trabajo activo por asset');
  update public.media_jobs set status = 'ready', finished_at = now() where asset_id = '40000000-0000-0000-0000-0000000000e2' and status = 'processing';
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-0000000000e2' $q$) is null, '15n. Con el trabajo en «ready» se publica');
  update public.assets set visibility = 'private' where id = '40000000-0000-0000-0000-0000000000e2';
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.assets set visibility = 'published' where id = '40000000-0000-0000-0000-0000000000e3' $q$) is null, '15o. La regla no afecta a las fotos');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.media_jobs (asset_id, status) values ('40000000-0000-0000-0000-0000000000e2', 'queued') $q$) is null, '15p. Tras terminar, se puede reprocesar (nuevo trabajo activo)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.transcoder_nonces (nonce) values ('n-1') $q$) is null and pg_temp.sqlstate_of($q$ insert into public.transcoder_nonces (nonce) values ('n-1') $q$) = '23505', '15q. Un nonce repetido se rechaza (anti-repetición)');
end $$;

-- RLS de video_jobs y de comments
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.media_jobs) = 0, '15r. El artista no lee los trabajos de procesado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, body) values ('40000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'hola') $q$) = '42501', '15s. Los clientes no escriben comentarios (van por acciones de servidor)');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d4');
do $$ begin
  perform pg_temp.chk((select count(*) from public.media_jobs) >= 3, '15t. admin lee los trabajos');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.comments (id, asset_id, user_id, body, timecode_ms) values
  ('c0000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'Corta aquí', 12500),
  ('c0000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d4', 'Ok', null);
insert into public.comments (id, asset_id, user_id, parent_id, body) values
  ('c0000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d4', 'c0000000-0000-0000-0000-000000000001', 'Hecho');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, body) values ('40000000-0000-0000-0000-0000000000e1', null, '') $q$) = '23514', '15u. Comentario vacío rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, body) values ('40000000-0000-0000-0000-0000000000e1', null, repeat('x', 2001)) $q$) = '23514', '15v. Más de 2000 caracteres rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, body, timecode_ms) values ('40000000-0000-0000-0000-0000000000e1', 'x', -5) $q$) = '23514', '15w. Marca de tiempo negativa rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, parent_id, body) values ('40000000-0000-0000-0000-0000000000e2', 'c0000000-0000-0000-0000-000000000001', 'x') $q$) = '23514', '15x. Una respuesta debe ser del mismo archivo que su padre');
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments where asset_id = '40000000-0000-0000-0000-0000000000e1') = 3, '15y. El artista asignado ve los comentarios del vídeo');
  perform pg_temp.chk((select total from public.comment_counts(array['40000000-0000-0000-0000-0000000000e1'::uuid])) = 3, '15z. comment_counts cuenta lo visible');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments) = 0, '15za. Un artista sin acceso al vídeo no ve sus comentarios');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.comments set deleted_at = now() where id = 'c0000000-0000-0000-0000-000000000002';
update public.artist_members set artist_id = '10000000-0000-0000-0000-00000000000b' where user_id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments) = 0, '15zb. Al perder el acceso al vídeo, dejas de ver sus comentarios');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.artist_members set artist_id = '10000000-0000-0000-0000-00000000000a' where user_id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments) = 2, '15zc. Un comentario borrado no se ve');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- Uso de almacenamiento por tipo de derivado
insert into public.asset_derivatives (asset_id, type, storage_key, size_bytes, status) values
  ('40000000-0000-0000-0000-0000000000e1', 'proxy', 'k-v1-proxy', 5000, 'ready'),
  ('40000000-0000-0000-0000-0000000000e1', 'poster', 'k-v1-poster', 300, 'ready');
do $$ begin
  perform pg_temp.chk((select bytes from public.storage_usage() where kind = 'derivative:proxy') >= 5000 and exists (select 1 from public.storage_usage() where kind = 'derivative:poster'), '15zd. storage_usage desglosa proxys y pósters');
end $$;

-- ---------------------------------------------------------------------------
-- 16. Fase 7 — beats: compartir, estados, descarga en tres capas, catálogo y búsqueda
--     (w1 = artist de A · w2 = «artistadl» de B · w3 = artist de C · w4 = «artistadl» sin asignar · w5 = admin)
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '', true);

insert into public.roles (key, name, scope, description) values ('artistadl', 'Artista con descarga', 'assigned', 'Escucha y descarga beats');
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['beats.view', 'beats.download', 'beats.comment']) k where r.key = 'artistadl';
insert into public.role_permissions (role_id, permission_key)
select r.id, k from public.roles r, unnest(array['beats.view', 'beats.comment', 'photos.view']) k where r.key = 'artist'
on conflict do nothing;
delete from public.role_permissions where permission_key = 'beats.download' and role_id = (select id from public.roles where key = 'artist');

insert into public.invitations (email, role_id)
select v.email, r.id from (values ('w1@t.local','artist'),('w2@t.local','artistadl'),('w3@t.local','artist'),('w4@t.local','artistadl'),('w5@t.local','admin')) as v(email, role_key)
join public.roles r on r.key = v.role_key;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'w1@t.local'), ('00000000-0000-0000-0000-0000000000e2', 'w2@t.local'),
  ('00000000-0000-0000-0000-0000000000e3', 'w3@t.local'), ('00000000-0000-0000-0000-0000000000e4', 'w4@t.local'),
  ('00000000-0000-0000-0000-0000000000e5', 'w5@t.local');
update public.invitations set status = 'accepted', accepted_at = now() where status = 'pending';
update public.profiles set status = 'active' where email in ('w1@t.local','w2@t.local','w3@t.local','w4@t.local','w5@t.local');

insert into public.artists (id, name, slug) values ('10000000-0000-0000-0000-0000000000c1', 'Artista C7', 'artista-c7');
insert into public.artist_members (artist_id, user_id) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000e1'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000e2'),
  ('10000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e3');

insert into public.genres (id, name) values ('70000000-0000-0000-0000-000000000001', 'Trap7'), ('70000000-0000-0000-0000-000000000002', 'Drill7');
insert into public.assets (id, kind, space, original_filename, storage_key, status, visibility, downloadable, uploaded_by) values
  ('41000000-0000-0000-0000-000000000001', 'audio', 'workspace', 'bx.wav', 'k-bx', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000e5'),
  ('41000000-0000-0000-0000-000000000002', 'audio', 'workspace', 'by.wav', 'k-by', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000e5'),
  ('41000000-0000-0000-0000-000000000003', 'audio', 'workspace', 'bz.wav', 'k-bz', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000e5'),
  ('41000000-0000-0000-0000-000000000004', 'photo', 'workspace', 'cover.jpg', 'k-cv', 'ready', 'published', true, '00000000-0000-0000-0000-0000000000e5');
insert into public.beats (id, asset_id, cover_asset_id, title, bpm, musical_key, genre_id, status, downloadable, created_by) values
  ('51000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000004', 'Bounce del Barrio', 140, 'Am', '70000000-0000-0000-0000-000000000001', 'published', true, '00000000-0000-0000-0000-0000000000e5'),
  ('51000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000002', null, 'Borrador', null, null, null, 'draft', true, '00000000-0000-0000-0000-0000000000e5'),
  ('51000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000003', null, 'Solo escuchar', 90, 'Cm', '70000000-0000-0000-0000-000000000002', 'published', false, '00000000-0000-0000-0000-0000000000e5');

do $$ begin
  -- Sin compartir, ningún artista ve nada
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16a. Un beat sin compartir no se ve (artista de A)');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'asset', '41000000-0000-0000-0000-000000000001'), '16b. Ni su audio, que se autoriza a través del beat');
end $$;

insert into public.beat_artists (beat_id, artist_id, can_download) values
  ('51000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000a', false),
  ('51000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000000b', false),
  ('51000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000a', true),
  ('51000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-00000000000b', true);

do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16c. Compartido con A: lo ve la gente de A');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e3', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16d. Quien es de otro artista (C) no lo ve');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'beat', '51000000-0000-0000-0000-000000000002'), '16e. Un borrador no se ve aunque esté compartido');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'asset', '41000000-0000-0000-0000-000000000001'), '16f. El audio del beat compartido se puede previsualizar (vía beat)');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'asset', '41000000-0000-0000-0000-000000000002'), '16g. El audio de un borrador no');
end $$;
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'asset', '41000000-0000-0000-0000-000000000004'), '16i. La portada se ve si se ve el beat');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e3', 'view', 'asset', '41000000-0000-0000-0000-000000000004'), '16j. Y no la ve quien no ve el beat');

  -- Descarga del original: tres capas
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16k. Capa 1: el rol artist no tiene beats.download (techo)');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e2', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16l. artistadl (de B) ve el beat compartido');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16m. Capa 3: sin can_download del artista, no descarga');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'asset', '41000000-0000-0000-0000-000000000001'), '16n. Tampoco por el asset (mismas reglas)');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'beat', '51000000-0000-0000-0000-000000000003'), '16o. Capa 2: can_download del artista pero beat con downloadable=false');
end $$;
update public.beat_artists set can_download = true where beat_id = '51000000-0000-0000-0000-000000000001' and artist_id = '10000000-0000-0000-0000-00000000000b';
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16p. Las tres capas cumplidas: descarga');
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'asset', '41000000-0000-0000-0000-000000000001'), '16q. También por el asset (lo que firma getAssetUrl)');
end $$;
update public.beats set downloadable = false where id = '51000000-0000-0000-0000-000000000001';
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e2', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16r. Si el beat deja de ser descargable, se corta');
end $$;
update public.beats set downloadable = true where id = '51000000-0000-0000-0000-000000000001';
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e5', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16s. Alcance «all» (admin): no necesita can_download del artista');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e4', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16t. Rol artistadl sin asignar ni grant: nada');
end $$;
insert into public.grants (user_id, resource_type, resource_id, can_view, can_download) values
  ('00000000-0000-0000-0000-0000000000e4', 'beat', '51000000-0000-0000-0000-000000000001', true, false);
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e4', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16u. Un grant directo concede ver');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e4', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16v. Sin descarga en el grant, no descarga');
end $$;
update public.grants set can_download = true where user_id = '00000000-0000-0000-0000-0000000000e4' and resource_type = 'beat';
do $$ begin
  perform pg_temp.chk(public.can_access('00000000-0000-0000-0000-0000000000e4', 'download', 'beat', '51000000-0000-0000-0000-000000000001'), '16w. Grant con descarga: descarga');
end $$;
update public.grants set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000e4';
delete from public.beat_artists where beat_id = '51000000-0000-0000-0000-000000000001' and artist_id = '10000000-0000-0000-0000-00000000000a';
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e4', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16x. Revocar el grant corta el acceso de inmediato');
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e1', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16y. Dejar de compartir con A corta el acceso de la gente de A');
end $$;
update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000e2';
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000e2', 'view', 'beat', '51000000-0000-0000-0000-000000000001'), '16z. Un usuario desactivado no ve nada');
end $$;
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000e2';

-- RLS de beat_artists y app_settings
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.beat_artists) = 2 and not exists (select 1 from public.beat_artists where artist_id <> '10000000-0000-0000-0000-00000000000b'), '16za. Cada artista solo lee SUS compartidos');
  perform pg_temp.chk((select count(*) from public.beats) = 2, '16zb. RLS: ve sus 2 beats compartidos y publicados (no el borrador)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.beat_artists (beat_id, artist_id) values ('51000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000000b') $q$) = '42501', '16zc. Los clientes no escriben beat_artists');
  perform pg_temp.chk((select count(*) from public.app_settings) = 0, '16zd. app_settings no es legible para un artista');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
insert into public.app_settings (key, value) values ('beat_voice_tag_interval_s', '25'::jsonb);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); -- owner
do $$ begin
  perform pg_temp.chk((select count(*) from public.app_settings) = 1, '16ze. El owner lee app_settings');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.act_as('00000000-0000-0000-0000-0000000000e5'); -- admin
do $$ begin
  perform pg_temp.chk((select count(*) from public.app_settings) = 0, '16zf. Ni el admin lee app_settings (solo owner)');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- Regla de publicación de beats
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.beats set status = 'published' where id = '51000000-0000-0000-0000-000000000002' $q$) = 'P0001', '16zg. Sin BPM, tonalidad ni género no se publica');
  update public.beats set bpm = 100, musical_key = 'Dm', genre_id = '70000000-0000-0000-0000-000000000001' where id = '51000000-0000-0000-0000-000000000002';
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.beats set status = 'published' where id = '51000000-0000-0000-0000-000000000002' $q$) = 'P0001', '16zh. Con datos completos pero sin preview listo, tampoco');
  insert into public.media_jobs (asset_id, kind, status) values ('41000000-0000-0000-0000-000000000002', 'audio', 'ready');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.beats set status = 'published' where id = '51000000-0000-0000-0000-000000000002' $q$) is null, '16zi. Con datos completos y el trabajo de audio «ready», se publica');
  update public.beats set status = 'draft' where id = '51000000-0000-0000-0000-000000000002';
  perform pg_temp.chk((select kind from public.media_jobs where asset_id = '41000000-0000-0000-0000-000000000002') = 'audio' and exists (select 1 from public.media_jobs where kind = 'video'), '16zj. media_jobs distingue audio y vídeo (los datos de vídeo se conservan)');
end $$;

-- Búsqueda de texto completo y catálogo con cursor
do $$ begin
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_q => 'boun')) = 1, '16zk. Búsqueda por prefijo «boun» encuentra «Bounce del Barrio»');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_q => 'BARRIO')) = 1, '16zl. Sin distinguir mayúsculas');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_q => 'drill')) = 1, '16zm. La búsqueda incluye el nombre del género');
  insert into public.tags (id, name) values ('72000000-0000-0000-0000-000000000001', 'oscuro7');
  insert into public.taggings (tag_id, resource_type, resource_id) values ('72000000-0000-0000-0000-000000000001', 'beat', '51000000-0000-0000-0000-000000000001');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_q => 'oscuro')) = 1, '16zn. Y las etiquetas (el índice se refresca al etiquetar)');
  update public.genres set name = 'Reggaeton7' where id = '70000000-0000-0000-0000-000000000002';
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_q => 'reggaeton')) = 1 and (select count(*) from public.beat_catalog(p_q => 'drill')) = 0, '16zo. Renombrar un género refresca el índice');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_bpm_min => 100, p_bpm_max => 150)) = (select count(*) from public.beats where bpm between 100 and 150 and deleted_at is null) and (select count(*) from public.beat_catalog(p_bpm_min => 100, p_bpm_max => 150)) >= 2, '16zp. Filtro por rango de BPM (coincide con la consulta directa)');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_keys => array['Cm'])) = 1, '16zq. Filtro por tonalidad');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_genres => array['70000000-0000-0000-0000-000000000001'::uuid])) = 2, '16zr. Filtro por género');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_tags => array['72000000-0000-0000-0000-000000000001'::uuid])) = 1, '16zs. Filtro por etiqueta');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_status => 'draft')) = 1, '16zt. Filtro por estado');
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_artist => '10000000-0000-0000-0000-00000000000b')) = 2, '16zu. Filtro por artista con acceso');
end $$;

-- 130 beats de paginación (compartidos con B), para el cursor de las tres ordenaciones
insert into public.assets (id, kind, space, original_filename, storage_key, status, visibility, downloadable)
select ('42000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'audio', 'workspace', 'p' || n || '.wav', 'k-p' || n, 'ready', 'published', true from generate_series(1, 130) n;
insert into public.beats (id, asset_id, title, bpm, musical_key, genre_id, status, downloadable, created_on)
select ('52000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, ('42000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       'Paginado ' || lpad(n::text, 3, '0'), 60 + (n % 90), 'Am', '70000000-0000-0000-0000-000000000001', 'published', false, current_date - (n % 40)
from generate_series(1, 130) n;
insert into public.beat_artists (beat_id, artist_id) select id, '10000000-0000-0000-0000-00000000000b' from public.beats where title like 'Paginado %';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000e2');
do $$
declare
  v_order text; v_total integer; v_pages integer; v_last_val text; v_last_id uuid; v_rows integer; v_seen uuid[] := '{}'; r record;
begin
  foreach v_order in array array['recent', 'name', 'bpm'] loop
    v_total := 0; v_pages := 0; v_last_val := null; v_last_id := null; v_seen := '{}';
    loop
      v_rows := 0;
      for r in select * from public.beat_catalog(p_order => v_order, p_after_val => v_last_val, p_after_id => v_last_id, p_limit => 50) loop
        v_rows := v_rows + 1; v_total := v_total + 1; v_last_val := r.sort_val; v_last_id := r.id;
        if r.id = any(v_seen) then v_total := v_total + 1000000; end if;
        v_seen := v_seen || r.id;
      end loop;
      v_pages := v_pages + 1;
      exit when v_rows < 50 or v_pages > 10;
    end loop;
    perform pg_temp.chk(v_total = 132 and v_pages = 3, '16zv. Cursor «' || v_order || '»: 132 beats visibles en 3 páginas, sin repetidos ni saltos (total ' || v_total || ', páginas ' || v_pages || ')');
  end loop;
  perform pg_temp.chk((select count(*) from public.beat_catalog(p_status => 'draft')) = 0, '16zw. El catálogo de un artista nunca incluye borradores');
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------------------
-- 17. Vault (Fase 8): rol + grant vigente (Vault o carpeta) + aal2, sin herencia, invisible para el RLS normal
-- ---------------------------------------------------------------------------
-- Estado limpio de grants del Vault para el usuario «vaultero»
delete from public.grants where user_id = '00000000-0000-0000-0000-0000000000a7';
update public.assets set artist_id = '10000000-0000-0000-0000-00000000000a' where id = '40000000-0000-0000-0000-000000000009';
insert into public.assets (id, kind, space, artist_id, folder_id, original_filename, storage_key, visibility, downloadable, uploaded_by, status)
select '71000000-0000-0000-0000-000000000001', 'video', 'vault', null, f.id, 'bts.mp4', 'kv2', 'private', false, '00000000-0000-0000-0000-0000000000a1', 'ready'
from public.folders f where f.space = 'vault' and f.name = 'BTS';
create temp table vf as select name, id from public.folders where space = 'vault';
grant select on vf to authenticated;

-- 17a. Quien no tiene el permiso en su rol (admin) ni existe para él
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null), '17a. admin sin vault.view: no accede al Vault');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17b. admin: no ve un asset del Vault');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'folder', (select id from vf where name = 'Documentos')), '17c. admin: no ve una carpeta del Vault');
end $$;
reset role;

-- 17d. Con rol pero SIN grant
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17d. rol con vault.view pero sin grant: denegado');
end $$;
reset role;

-- 17e. Con grant de Vault vigente (30 días) y aal2: pasa; con aal1: NO
insert into public.grants (user_id, resource_type, resource_id, can_view, can_download, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'vault', null, true, true, now() + interval '30 days');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17e. grant vigente + rol + aal2: ve el asset del Vault');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'vault', null) and public.can_access(auth.uid(), 'view', 'folder', (select id from vf where name = 'BTS')), '17f. ...el espacio y sus carpetas');
  perform pg_temp.chk(public.can_access(auth.uid(), 'download', 'asset', '71000000-0000-0000-0000-000000000001'), '17g. en el Vault no cuenta `downloadable` del asset: descarga con can_download');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'edit', 'asset', '40000000-0000-0000-0000-000000000009'), '17h. sin vault.edit no edita aunque el grant lo permitiera');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7', 'aal1');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17i. sin aal2 (solo contraseña): denegado aunque tenga rol y grant');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null), '17j. ...tampoco el espacio Vault');
end $$;
reset role;

-- 17k. El owner pasa rol y grant pero también necesita aal2
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'aal1');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null) and not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17k. owner sin aal2: denegado');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1', 'aal2');
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'delete', 'asset', '40000000-0000-0000-0000-000000000009') and public.can_access(auth.uid(), 'view', 'vault', null), '17l. owner con aal2: accede sin grant');
end $$;
reset role;

-- 17m. Artista informativo: un miembro del artista NO obtiene acceso al Vault por ese vínculo
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17m. el artista relacionado no da acceso (solo informativo)');
end $$;
reset role;

-- 17n. Grant revocado y grant caducado dejan de valer al instante
update public.grants set revoked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a7' and resource_type = 'vault';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17n. grant revocado: denegado en el acto');
end $$;
reset role;
insert into public.grants (user_id, resource_type, resource_id, can_view, created_at, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'vault', null, true, now() - interval '10 days', now() - interval '1 day');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17o. grant caducado: denegado');
end $$;
reset role;

-- 17p. Grant por carpeta concreta (Documentos): solo esa carpeta
delete from public.grants where user_id = '00000000-0000-0000-0000-0000000000a7';
insert into public.grants (user_id, resource_type, resource_id, can_view, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'folder', (select id from vf where name = 'Documentos'), true, now() + interval '7 days');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17p. grant de carpeta: ve el asset de ESA carpeta');
  perform pg_temp.chk(public.can_access(auth.uid(), 'view', 'folder', (select id from vf where name = 'Documentos')), '17q. ...y la carpeta');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '71000000-0000-0000-0000-000000000001'), '17r. ...pero no el asset de otra carpeta del Vault (BTS)');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'folder', (select id from vf where name = 'BTS')), '17s. ...ni otra carpeta');
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'vault', null), '17t. ...ni el Vault entero');
end $$;
reset role;

-- 17u. Un grant sobre una carpeta NORMAL no abre ningún asset del Vault
delete from public.grants where user_id = '00000000-0000-0000-0000-0000000000a7';
insert into public.grants (user_id, resource_type, resource_id, can_view, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'folder', '30000000-0000-0000-0000-000000000001', true, now() + interval '7 days');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk(not public.can_access(auth.uid(), 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17u. un grant de carpeta normal no abre el Vault');
end $$;
reset role;

-- 17v. Usuario desactivado con grant vigente
delete from public.grants where user_id = '00000000-0000-0000-0000-0000000000a7';
insert into public.grants (user_id, resource_type, resource_id, can_view, expires_at)
values ('00000000-0000-0000-0000-0000000000a7', 'vault', null, true, now() + interval '30 days');
update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a7';
do $$ begin
  perform pg_temp.chk(not public.can_access('00000000-0000-0000-0000-0000000000a7', 'view', 'asset', '40000000-0000-0000-0000-000000000009'), '17v. usuario desactivado: denegado');
end $$;
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a7';

-- 17w. Restricciones: caducidad obligatoria y máxima de 90 días; carpetas del Vault igual
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, can_view) values ('00000000-0000-0000-0000-0000000000a3', 'vault', true) $q$) = '23514', '17w. grant de Vault sin caducidad: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, can_view, expires_at) values ('00000000-0000-0000-0000-0000000000a3', 'vault', true, now() + interval '91 days') $q$) = '23514', '17x. grant de Vault a 91 días: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, can_view, expires_at) values ('00000000-0000-0000-0000-0000000000a3', 'vault', true, now() + interval '89 days') $q$) is null, '17y. grant de Vault a 89 días: admitido');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, resource_id, can_view) values ('00000000-0000-0000-0000-0000000000a4', 'folder', (select id from vf where name = 'BTS'), true) $q$) = '23514', '17z. grant de carpeta del Vault sin caducidad: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.grants (user_id, resource_type, resource_id, can_view) values ('00000000-0000-0000-0000-0000000000a5', 'folder', '30000000-0000-0000-0000-000000000002', true) $q$) is null, '17za. grant de carpeta NORMAL sin caducidad: sigue permitido');
end $$;

-- 17zb. Coherencia de assets y carpetas del Vault
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.assets (kind, space, original_filename, storage_key) values ('document', 'vault', 'x.pdf', 'kx1') $q$) = 'P0001', '17zb. un asset del Vault sin carpeta del Vault: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.assets (kind, space, session_id, folder_id, original_filename, storage_key) values ('document', 'vault', '20000000-0000-0000-0000-00000000000a', (select id from vf where name = 'BTS'), 'x.pdf', 'kx2') $q$) = 'P0001', '17zc. un asset del Vault dentro de una sesión: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.assets (kind, space, folder_id, original_filename, storage_key) values ('document', 'workspace', (select id from vf where name = 'BTS'), 'x.pdf', 'kx3') $q$) = 'P0001', '17zd. un asset normal en una carpeta del Vault: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.folders (name, space, artist_id) values ('Con artista', 'vault', '10000000-0000-0000-0000-00000000000a') $q$) = '23514', '17ze. una carpeta del Vault con artista: rechazada');
  perform pg_temp.chk((select count(*) from public.folders where space = 'vault' and parent_id is null) = 6, '17zf. las 6 carpetas base del Vault existen');
end $$;

-- 17zg. RLS: el Vault no se ve en NINGUNA consulta normal, ni siquiera con rol, grant y aal2
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a7');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where space = 'vault') = 0, '17zg. consulta normal de assets: cero filas del Vault (con grant y aal2)');
  perform pg_temp.chk((select count(*) from public.folders where space = 'vault') = 0, '17zh. consulta normal de carpetas: cero filas del Vault');
  perform pg_temp.chk((select count(*) from public.assets where id = '40000000-0000-0000-0000-000000000009') = 0, '17zi. ni siquiera por id');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.assets where space = 'vault') = 0, '17zj. ni el owner ve el Vault por la vía normal');
  perform pg_temp.chk((select count(*) from public.folders where space = 'vault') = 0, '17zk. ...ni sus carpetas');
end $$;
reset role;

-- 17zl. activity_log: prefijo reservado, solo acciones conocidas; quien gestiona accesos no lee el registro del Vault
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.activity_log (actor_id, action) values (null, 'vault.inventada') $q$) = '23514', '17zl. acción «vault.» desconocida: rechazada');
end $$;
insert into public.activity_log (actor_id, action, resource_type, resource_id, metadata)
select '00000000-0000-0000-0000-0000000000a1', a, 'asset', '40000000-0000-0000-0000-000000000009', '{}'::jsonb
from unnest(array['vault.open','vault.list','vault.preview','vault.download','vault.upload','vault.move_in','vault.move_out','vault.trash','vault.restore','vault.delete','vault.grant','vault.revoke']) a;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.activity_log where action like 'vault.%') = 0, '17zm. el admin con access.manage NO lee el registro del Vault');
  perform pg_temp.chk((select count(*) from public.artist_activity('10000000-0000-0000-0000-00000000000a') where action like 'vault.%' or resource_id = '40000000-0000-0000-0000-000000000009') = 0, '17zn. la actividad del artista no incluye eventos del Vault');
end $$;
reset role;
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.activity_log set action = 'x' where action like 'vault.%' $q$) = 'P0001', '17zo. el registro del Vault es de solo inserción (update)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.activity_log where action like 'vault.%' $q$) = 'P0001', '17zp. ...ni se borra');
end $$;

-- 17zq. Almacenamiento: el Vault es una línea aparte; y nunca admite comentarios
do $$ begin
  perform pg_temp.chk((select coalesce(sum(files), 0) from public.storage_usage() where kind = 'vault') = 2, '17zq. storage_usage: el Vault aparece como línea aparte (2 archivos)');
  perform pg_temp.chk(not public.can_comment('00000000-0000-0000-0000-0000000000a1', '71000000-0000-0000-0000-000000000001'), '17zs. no se puede comentar un archivo del Vault');
end $$;

-- ---------------------------------------------------------------------------
-- 18. Colaboración (Fase 9): enlaces externos, comentarios externos, notificaciones y límites
-- ---------------------------------------------------------------------------
insert into public.share_links (id, token_hash, resource_type, resource_id, resource_ids, title, expires_at, created_by, can_comment) values
  ('a8000000-0000-0000-0000-000000000001', 'hash-1', 'session',   '20000000-0000-0000-0000-00000000000a', null, 'Sesión A', now() + interval '7 days', '00000000-0000-0000-0000-0000000000a2', false),
  ('a8000000-0000-0000-0000-000000000002', 'hash-2', 'asset_set', null, array['40000000-0000-0000-0000-000000000001']::uuid[], 'Selección', now() + interval '3 days', '00000000-0000-0000-0000-0000000000a1', true),
  ('a8000000-0000-0000-0000-000000000003', 'hash-3', 'beat_set',  null, array['50000000-0000-0000-0000-000000000001']::uuid[], 'Beats', now() + interval '1 day', '00000000-0000-0000-0000-0000000000a5', false);
insert into public.share_link_events (link_id, type, ip_hash, user_agent) values
  ('a8000000-0000-0000-0000-000000000001', 'open', 'ip1', 'Chrome'),
  ('a8000000-0000-0000-0000-000000000003', 'open', 'ip2', 'Safari');

-- 18a. Quién ve los enlaces y sus eventos: access.manage (owner, admin) o el creador; nadie más
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 3, '18a. admin (access.manage) ve todos los enlaces');
  perform pg_temp.chk((select count(*) from public.share_link_events) = 2, '18b. ...y sus eventos');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 3, '18c. owner ve todos los enlaces');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 1 and (select title from public.share_links) = 'Beats', '18d. el creador sin access.manage ve SOLO el suyo');
  perform pg_temp.chk((select count(*) from public.share_link_events) = 1, '18e. ...y solo sus eventos');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 0 and (select count(*) from public.share_link_events) = 0, '18f. un artista no ve enlaces ni eventos');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a6');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 0, '18g. un colaborador no ve enlaces');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');
do $$ begin
  perform pg_temp.chk((select count(*) from public.share_links) = 0, '18h. un usuario sin acceso no ve enlaces');
end $$;
reset role;

-- 18i. Desde el cliente nadie escribe (ni el owner): todo va por acciones de servidor
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) values ('x', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() + interval '1 day') $q$) = '42501', '18i. el owner no crea enlaces desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.share_links set revoked_at = now() $q$) = '42501', '18j. ...ni los revoca');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.share_links $q$) = '42501', '18k. ...ni los borra');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_link_events (link_id, type) values ('a8000000-0000-0000-0000-000000000001', 'open') $q$) = '42501', '18l. ...ni escribe eventos');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select public.rate_hit('x', 60, 5) $q$) = '42501', '18m. rate_hit no se puede llamar desde el cliente');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ select count(*) from public.notification_outbox $q$) = '42501', '18n. la cola de correo no es legible desde el cliente');
end $$;
reset role;

-- 18o. Restricciones: caducidad obligatoria (máx. 30 días), forma del recurso, token único, nada del Vault
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title) values ('n1', 'session', '20000000-0000-0000-0000-00000000000a', 't') $q$) = '23502', '18o. sin caducidad: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) values ('n2', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() + interval '31 days') $q$) = '23514', '18p. caducidad a 31 días: rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) values ('n3', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() - interval '1 day') $q$) = '23514', '18q. caducidad en el pasado: rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) values ('n4', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() + interval '30 days') $q$) is null, '18r. caducidad a 30 días: admitida');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, resource_ids, title, expires_at) values ('n5', 'session', '20000000-0000-0000-0000-00000000000a', array['40000000-0000-0000-0000-000000000001']::uuid[], 't', now() + interval '1 day') $q$) = '23514', '18s. una sesión con lista de ids: rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_ids, title, expires_at) values ('n6', 'asset_set', array[]::uuid[], 't', now() + interval '1 day') $q$) = '23514', '18t. una selección vacía: rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) values ('hash-1', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() + interval '1 day') $q$) = '23505', '18u. token repetido: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at, max_downloads) values ('n7', 'session', '20000000-0000-0000-0000-00000000000a', 't', now() + interval '1 day', 0) $q$) = '23514', '18v. límite de descargas 0: rechazado');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_ids, title, expires_at) values ('n8', 'asset_set', array['40000000-0000-0000-0000-000000000009']::uuid[], 't', now() + interval '1 day') $q$) = 'P0001', '18w. una selección con un archivo del Vault: rechazada por la base de datos');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_ids, title, expires_at) values ('n9', 'asset_set', array['40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000009']::uuid[], 't', now() + interval '1 day') $q$) = 'P0001', '18x. ...aunque vaya mezclada con otros archivos');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_id, title, expires_at) select 'n10', 'folder', id, 't', now() + interval '1 day' from public.folders where space = 'vault' limit 1 $q$) = 'P0001', '18y. una carpeta del Vault: rechazada');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_links (token_hash, resource_type, resource_ids, title, expires_at) values ('n11', 'beat_set', array['50000000-0000-0000-0000-000000000001']::uuid[], 't', now() + interval '1 day') $q$) is null, '18z. una selección de beats normales: admitida');
end $$;

-- 18za. Eventos: solo inserción
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.share_link_events set type = 'view' $q$) = 'P0001', '18za. los eventos de enlace no se editan');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ delete from public.share_link_events $q$) = 'P0001', '18zb. ...ni se borran');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.share_link_events (link_id, type) values ('a8000000-0000-0000-0000-000000000001', 'hackeo') $q$) = '23514', '18zc. tipos de evento cerrados');
end $$;

-- 18zd. Límite de peticiones: 5 por ventana y clave
do $$
declare ok_count int := 0; i int; last_ok boolean;
begin
  for i in 1..5 loop if public.rate_hit('pw:test', 900, 5) then ok_count := ok_count + 1; end if; end loop;
  last_ok := public.rate_hit('pw:test', 900, 5);
  perform pg_temp.chk(ok_count = 5 and not last_ok, '18zd. rate_hit: 5 permitidas y la 6.ª se bloquea');
  perform pg_temp.chk(public.rate_hit('pw:otro', 900, 5), '18ze. ...cada clave tiene su propio contador');
end $$;

-- 18zf. Comentarios externos: forma, y quién los ve
insert into public.comments (asset_id, user_id, external_name, share_link_id, body)
values ('40000000-0000-0000-0000-0000000000e3', null, 'Visitante', 'a8000000-0000-0000-0000-000000000002', 'Me encanta');
do $$ begin
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, external_name, share_link_id, body, mentions) values ('40000000-0000-0000-0000-0000000000e3', null, 'V', 'a8000000-0000-0000-0000-000000000002', 'x', array['00000000-0000-0000-0000-0000000000a1']::uuid[]) $q$) = '23514', '18zf. un comentario externo no admite menciones');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, external_name, share_link_id, body) values ('40000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', 'V', 'a8000000-0000-0000-0000-000000000002', 'x') $q$) = '23514', '18zg. ni nombre externo con usuario a la vez');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, external_name, body) values ('40000000-0000-0000-0000-0000000000e3', null, 'V', 'x') $q$) = '23514', '18zh. un nombre externo exige enlace');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, user_id, external_name, share_link_id, body) values ('40000000-0000-0000-0000-0000000000e3', null, '', 'a8000000-0000-0000-0000-000000000002', 'x') $q$) = '23514', '18zi. el nombre del visitante no puede ir vacío');
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments where external_name is not null and asset_id = '40000000-0000-0000-0000-0000000000e3') = 1, '18zj. un artista con acceso al archivo ve el comentario externo');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.comments (asset_id, body) values ('40000000-0000-0000-0000-0000000000e3', 'x') $q$) = '42501', '18zk. el cliente no escribe comentarios (solo acciones de servidor)');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000d2');
do $$ begin
  perform pg_temp.chk((select count(*) from public.comments where asset_id = '40000000-0000-0000-0000-0000000000e3') = 0, '18zl. quien no tiene acceso al archivo no ve sus comentarios');
end $$;
reset role;

-- 18zm. Notificaciones y preferencias: cada persona solo las suyas
insert into public.notification_settings (user_id, event, channel, frequency) values
  ('00000000-0000-0000-0000-0000000000a3', 'comment', 'off', 'instant'),
  ('00000000-0000-0000-0000-0000000000a4', 'comment', 'email', 'daily');
insert into public.notifications (user_id, type, payload) values
  ('00000000-0000-0000-0000-0000000000a3', 'comment', '{"title":"x"}'),
  ('00000000-0000-0000-0000-0000000000a3', 'mention', '{"title":"y"}'),
  ('00000000-0000-0000-0000-0000000000a4', 'comment', '{"title":"z"}');
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');
do $$ begin
  perform pg_temp.chk((select count(*) from public.notifications) = 2 and (select count(*) from public.notification_settings) = 1, '18zm. cada persona ve solo sus notificaciones y sus preferencias');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ update public.notifications set read_at = now() $q$) = '42501', '18zn. el cliente no marca notificaciones (acción de servidor)');
  perform pg_temp.chk(pg_temp.sqlstate_of($q$ insert into public.notifications (user_id, type) values ('00000000-0000-0000-0000-0000000000a3', 'x') $q$) = '42501', '18zo. ni las crea');
end $$;
reset role;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform pg_temp.chk((select count(*) from public.notifications) = 0, '18zp. ni siquiera el owner lee las notificaciones de otras personas');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 19. Auditoría estructural (Fase 10): RLS en todo, sin escrituras de cliente, sin sesión = nada
-- ---------------------------------------------------------------------------
do $$ begin
  perform pg_temp.chk((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity) = 0, '19a. RLS activada en TODAS las tablas de public');
  perform pg_temp.chk((select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) = 0, '19b. ni anon ni authenticated tienen privilegios de escritura sobre ninguna tabla');
  perform pg_temp.chk((select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon') = 0, '19c. anon no tiene ningún privilegio sobre tablas');
  perform pg_temp.chk((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and not coalesce(p.proconfig::text, '') like '%search_path%') = 0, '19d. toda función SECURITY DEFINER fija su search_path');
  perform pg_temp.chk((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')) = 0, '19e. anon no puede ejecutar ninguna función SECURITY DEFINER');
  perform pg_temp.chk((select count(*) from pg_policies where schemaname = 'public' and cmd <> 'SELECT') = 0, '19f. no hay ninguna política de escritura: los clientes solo leen');
  perform pg_temp.chk(not has_function_privilege('authenticated', 'public.rate_hit(text, integer, integer)', 'execute') and not has_function_privilege('authenticated', 'public.share_register_open(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.share_register_download(uuid)', 'execute'), '19g. los contadores de enlaces y de límites solo los ejecuta el servidor');
  perform pg_temp.chk((select array_agg(c.relname::text order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)) = array['backup_runs', 'error_log', 'mfa_recovery_codes', 'notification_outbox', 'ops_alerts', 'rate_limits', 'storage_orphans', 'transcoder_nonces', 'vault_moves', 'vault_unlock_attempts'], '19h. las únicas tablas sin política de lectura son las de uso exclusivo del servidor (lista cerrada)');
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

-- Un resultado por caso (justo antes del ROLLBACK; psql lo imprime)
select n, case when ok then 'OK' else 'FALLO' end as resultado, label as caso from results order by n;

rollback;

select 'PERMISSIONS OK' as resultado;
