-- MLS Drive — Fase 1: autenticación, usuarios e invitaciones
--
-- Modelo de acceso:
--  * Las cuentas solo se crean por invitación (el trigger rechaza cualquier alta sin invitación pendiente).
--  * profiles.status es la ÚNICA puerta de acceso a datos: solo 'active' pasa por RLS.
--      - Al invitar, el perfil nace 'disabled'; pasa a 'active' cuando el invitado acepta (/invitacion).
--      - El admin desactiva/reactiva cambiando ese mismo campo.
--  * Nadie escribe desde el cliente: no hay políticas ni privilegios de escritura para anon/authenticated.
--    Todas las escrituras van por acciones de servidor con el service role.

-- ---------------------------------------------------------------------------
-- roles (tabla, no enum: en la Fase 2 el admin podrá crear roles propios)
-- ---------------------------------------------------------------------------
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name        text not null,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now()
);

insert into public.roles (key, name, is_system) values
  ('owner',        'Owner',        true),
  ('admin',        'Admin',        true),
  ('artist',       'Artist',       true),
  ('photographer', 'Photographer', true),
  ('collaborator', 'Collaborator', true);

-- ---------------------------------------------------------------------------
-- profiles (1:1 con auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  full_name     text,
  avatar_url    text,
  role_id       uuid not null references public.roles (id),
  status        text not null default 'disabled' check (status in ('active', 'disabled')),
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create unique index profiles_email_key on public.profiles (lower(email));
create index profiles_role_id_idx on public.profiles (role_id);

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------
create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  role_id      uuid not null references public.roles (id),
  invited_by   uuid references public.profiles (id) on delete set null, -- null: alta inicial del owner (script)
  status       text not null default 'pending'
               check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz
);

-- Una invitación pendiente por email.
create unique index invitations_one_pending_per_email
  on public.invitations (lower(email)) where status = 'pending';
create index invitations_role_id_idx on public.invitations (role_id);
create index invitations_invited_by_idx on public.invitations (invited_by);

-- ---------------------------------------------------------------------------
-- Funciones
-- ---------------------------------------------------------------------------

-- Clave de rol del usuario autenticado. NULL si no hay sesión, no hay perfil o el perfil no está activo.
-- security definer: lee profiles sin pasar por RLS (evita recursión en las políticas).
create or replace function public.current_role_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.key
  from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = auth.uid()
    and p.status = 'active'
$$;

-- ¿El usuario autenticado es owner o admin activo?
create or replace function public.is_admin_or_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_role_key() in ('owner', 'admin'), false)
$$;

-- Invitación pendiente del usuario autenticado (para la pantalla /invitacion).
-- Un usuario invitado aún está 'disabled', así que no puede leer invitaciones por RLS:
-- esta función expone SOLO su propia invitación, y solo los campos necesarios.
create or replace function public.my_pending_invitation()
returns table (
  id            uuid,
  email         text,
  role_key      text,
  role_name     text,
  inviter_name  text,
  expires_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id,
         i.email,
         r.key,
         r.name,
         coalesce(nullif(inviter.full_name, ''), inviter.email),
         i.expires_at
  from public.profiles me
  join public.invitations i on lower(i.email) = lower(me.email) and i.status = 'pending'
  join public.roles r on r.id = i.role_id
  left join public.profiles inviter on inviter.id = i.invited_by
  where me.id = auth.uid()
$$;

-- Alta de usuario en auth.users => crea su perfil a partir de la invitación pendiente.
-- Sin invitación pendiente NO se crea el usuario (defensa en profundidad si el registro
-- público se activara por error en el panel de Supabase).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invitations%rowtype;
begin
  select * into inv
  from public.invitations
  where lower(email) = lower(new.email)
    and status = 'pending'
    and expires_at > now()
  limit 1;

  if not found then
    raise exception 'Registro no permitido: este correo no tiene una invitación vigente'
      using errcode = 'P0001';
  end if;

  insert into public.profiles (id, email, full_name, role_id, status)
  values (
    new.id,
    lower(new.email),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    inv.role_id,
    'disabled' -- se activa al aceptar la invitación
  );

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Defensa extra: el owner no se puede desactivar ni cambiar de rol (ni por un bug de la app).
create or replace function public.protect_owner_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_role uuid;
begin
  select id into owner_role from public.roles where key = 'owner';
  if old.role_id = owner_role
     and (new.role_id <> old.role_id or (old.status = 'active' and new.status = 'disabled')) then
    raise exception 'El owner no se puede desactivar ni degradar' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger protect_owner_profile
  before update on public.profiles
  for each row execute function public.protect_owner_profile();

-- ---------------------------------------------------------------------------
-- Privilegios: solo lectura para usuarios autenticados; nada para anon.
-- ---------------------------------------------------------------------------
revoke all on public.roles, public.profiles, public.invitations from anon, authenticated;
grant select on public.roles, public.profiles, public.invitations to authenticated;

revoke execute on function
  public.current_role_key(),
  public.is_admin_or_owner(),
  public.my_pending_invitation(),
  public.handle_new_user(),
  public.protect_owner_profile()
from public, anon, authenticated;

grant execute on function
  public.current_role_key(),
  public.is_admin_or_owner(),
  public.my_pending_invitation()
to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.invitations enable row level security;

-- roles: cualquier usuario activo puede leerlos (nombres de rol en la interfaz).
create policy roles_select_active
  on public.roles for select to authenticated
  using (public.current_role_key() is not null);

-- profiles: cada usuario lee SOLO el suyo (aunque esté desactivado, para poder informarle);
-- owner y admin activos leen todos.
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy profiles_select_admin
  on public.profiles for select to authenticated
  using (public.is_admin_or_owner());

-- invitations: solo owner y admin activos.
create policy invitations_select_admin
  on public.invitations for select to authenticated
  using (public.is_admin_or_owner());

-- Sin políticas de insert/update/delete: con RLS activa quedan denegadas para anon y authenticated.
-- (Además se revocaron los privilegios arriba.) El service role las salta por diseño.
