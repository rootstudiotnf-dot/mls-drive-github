-- MLS Drive — pruebas de RLS y de reglas de acceso (Fase 1)
--
-- Cómo ejecutarlas: SQL Editor de Supabase (rol postgres) o `psql`, DESPUÉS de aplicar 0001_auth.sql.
-- Todo va dentro de una transacción que termina en ROLLBACK: no deja datos.
-- Cada comprobación usa `assert`: si algo falla, el script se detiene con el mensaje del caso.
-- Si llega al final imprime "RLS OK".

begin;

-- ---------------------------------------------------------------------------
-- Utilidades (viven solo en esta sesión)
-- ---------------------------------------------------------------------------

-- Simula una sesión de PostgREST: rol `authenticated` con auth.uid() = uid.
create function pg_temp.act_as(uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

-- Ejecuta una sentencia y devuelve el SQLSTATE del error (o NULL si no falló).
create function pg_temp.sqlstate_of(stmt text) returns text
language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ---------------------------------------------------------------------------
-- Datos de prueba (como postgres: salta RLS)
-- ---------------------------------------------------------------------------
insert into public.invitations (email, role_id)
select v.email, r.id
from (values
  ('owner@test.local',   'owner'),
  ('admin@test.local',   'admin'),
  ('artist@test.local',  'artist'),
  ('artist2@test.local', 'artist')
) as v(email, role_key)
join public.roles r on r.key = v.role_key;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'admin@test.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'artist@test.local'),
  ('00000000-0000-0000-0000-0000000000a4', 'artist2@test.local');

update public.invitations set status = 'accepted', accepted_at = now()
where status = 'pending';

-- Invitación pendiente + usuario invitado (aún sin aceptar).
insert into public.invitations (email, role_id, invited_by)
select 'nuevo@test.local', r.id, '00000000-0000-0000-0000-0000000000a2'
from public.roles r where r.key = 'photographer';
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a5', 'nuevo@test.local');

-- Los cuatro primeros aceptaron: pasan a 'active'. El invitado (a5) sigue 'disabled'.
update public.profiles set status = 'active'
where id in (
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a4');

-- ---------------------------------------------------------------------------
-- 0. Alta de usuarios y estado inicial
-- ---------------------------------------------------------------------------
do $$
begin
  assert pg_temp.sqlstate_of($q$
    insert into auth.users (id, email) values (gen_random_uuid(), 'intruso@test.local')
  $q$) = 'P0001', '0a. Un alta SIN invitación debe rechazarse (registro público inexistente)';

  assert (select status from public.profiles where email = 'nuevo@test.local') = 'disabled',
    '0b. Un invitado nace con status disabled hasta aceptar';

  assert (select count(*) from public.roles where is_system) = 5,
    '0c. Deben existir los 5 roles de sistema';

  assert pg_temp.sqlstate_of($q$
    insert into public.invitations (email, role_id)
    select 'nuevo@test.local', id from public.roles where key = 'artist'
  $q$) = '23505', '0d. Solo puede haber una invitación pendiente por email';
end $$;

-- ---------------------------------------------------------------------------
-- 1. Artist: solo ve lo suyo
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');

do $$
begin
  assert (select count(*) from public.profiles) = 1, '1a. Un artist solo lee UN perfil';
  assert (select id from public.profiles) = '00000000-0000-0000-0000-0000000000a3',
    '1b. Ese perfil es el suyo';
  assert (select count(*) from public.profiles where id = '00000000-0000-0000-0000-0000000000a1') = 0,
    '1c. Un artist NO lee el perfil del owner';
  assert (select count(*) from public.invitations) = 0, '1d. Un artist NO lee invitaciones';
  assert (select count(*) from public.roles) >= 5, '1e. Un artist sí lee los roles';
  assert public.current_role_key() = 'artist', '1f. current_role_key() = artist';
  assert not public.is_admin_or_owner(), '1g. Un artist no es admin';
  assert (select count(*) from public.my_pending_invitation()) = 0,
    '1h. Un usuario que ya aceptó no tiene invitación pendiente';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. Nadie escribe desde el cliente (ni siquiera owner/admin)
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a3');

do $$
begin
  assert pg_temp.sqlstate_of($q$
    update public.profiles set role_id = (select id from public.roles where key = 'owner')
    where id = '00000000-0000-0000-0000-0000000000a3'
  $q$) = '42501', '2a. Un artist NO puede subirse el rol (update en profiles denegado)';

  assert pg_temp.sqlstate_of($q$
    update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a5'
  $q$) = '42501', '2b. Un artist NO puede activar cuentas ajenas';

  assert pg_temp.sqlstate_of($q$
    insert into public.invitations (email, role_id)
    select 'x@test.local', id from public.roles where key = 'artist'
  $q$) = '42501', '2c. Un artist NO puede crear invitaciones';

  assert pg_temp.sqlstate_of($q$
    delete from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'
  $q$) = '42501', '2d. Un artist NO puede borrar perfiles';

  assert pg_temp.sqlstate_of($q$
    insert into public.roles (key, name) values ('hacker', 'Hacker')
  $q$) = '42501', '2e. Un artist NO puede crear roles';
end $$;

reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); -- admin

do $$
begin
  assert pg_temp.sqlstate_of($q$
    insert into public.invitations (email, role_id)
    select 'x@test.local', id from public.roles where key = 'artist'
  $q$) = '42501', '2f. Un admin tampoco escribe desde el cliente (solo servidor)';

  assert pg_temp.sqlstate_of($q$
    update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a3'
  $q$) = '42501', '2g. Un admin tampoco actualiza perfiles desde el cliente';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. Owner y admin leen todo
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1'); -- owner

do $$
begin
  assert (select count(*) from public.profiles) = 5, '3a. El owner lee todos los perfiles';
  assert (select count(*) from public.invitations) = 5, '3b. El owner lee todas las invitaciones';
  assert public.current_role_key() = 'owner', '3c. current_role_key() = owner';
end $$;

reset role;

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2'); -- admin

do $$
begin
  assert (select count(*) from public.profiles) = 5, '3d. El admin lee todos los perfiles';
  assert (select count(*) from public.invitations) = 5, '3e. El admin lee todas las invitaciones';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 4. Usuario desactivado: sin acceso aunque conserve la sesión
-- ---------------------------------------------------------------------------
update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a4';

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a4');

do $$
begin
  assert public.current_role_key() is null, '4a. Un usuario desactivado no tiene rol efectivo';
  assert (select count(*) from public.roles) = 0, '4b. Un usuario desactivado no lee roles';
  assert (select count(*) from public.invitations) = 0, '4c. Un usuario desactivado no lee invitaciones';
  assert (select count(*) from public.profiles) = 1,
    '4d. Solo puede leer su propio perfil (para que la app le informe)';
  assert (select status from public.profiles) = 'disabled', '4e. Y ese perfil dice disabled';
end $$;

reset role;

-- Admin desactivado deja de leer perfiles ajenos.
update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a2');

do $$
begin
  assert (select count(*) from public.profiles) = 1, '4f. Un admin desactivado ya no lee otros perfiles';
  assert (select count(*) from public.invitations) = 0, '4g. Ni invitaciones';
end $$;

reset role;
update public.profiles set status = 'active' where id = '00000000-0000-0000-0000-0000000000a2';

-- ---------------------------------------------------------------------------
-- 5. Invitado (aún disabled): solo ve SU invitación y nada más
-- ---------------------------------------------------------------------------
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a5');

do $$
declare
  inv record;
begin
  select * into inv from public.my_pending_invitation();
  assert inv.email = 'nuevo@test.local', '5a. El invitado ve su propia invitación';
  assert inv.role_key = 'photographer', '5b. Con el rol que le corresponde';
  assert (select count(*) from public.invitations) = 0, '5c. Pero no puede listar la tabla de invitaciones';
  assert (select count(*) from public.profiles) = 1, '5d. Ni leer perfiles ajenos';
  assert public.current_role_key() is null, '5e. Hasta aceptar no tiene rol efectivo';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 6. Anónimo: nada
-- ---------------------------------------------------------------------------
set local role anon;

do $$
begin
  assert pg_temp.sqlstate_of('select * from public.profiles') = '42501',
    '6a. anon no puede leer profiles';
  assert pg_temp.sqlstate_of('select * from public.invitations') = '42501',
    '6b. anon no puede leer invitations';
  assert pg_temp.sqlstate_of('select * from public.roles') = '42501',
    '6c. anon no puede leer roles';
  assert pg_temp.sqlstate_of('select public.current_role_key()') = '42501',
    '6d. anon no puede ejecutar current_role_key()';
end $$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. El owner no se puede desactivar ni degradar (ni con el service role)
-- ---------------------------------------------------------------------------
do $$
begin
  assert pg_temp.sqlstate_of($q$
    update public.profiles set status = 'disabled' where id = '00000000-0000-0000-0000-0000000000a1'
  $q$) = 'P0001', '7a. El owner no se puede desactivar';

  assert pg_temp.sqlstate_of($q$
    update public.profiles set role_id = (select id from public.roles where key = 'artist')
    where id = '00000000-0000-0000-0000-0000000000a1'
  $q$) = 'P0001', '7b. El owner no se puede degradar';
end $$;

rollback;

select 'RLS OK' as resultado;
