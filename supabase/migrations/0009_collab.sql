-- MLS Drive — Fase 9: Colaboración (enlaces externos, comentarios ampliados, notificaciones)
--
-- Idempotente (reaplicable). Aplicar DESPUÉS de 0001–0008.
--
--  1. share_links / share_link_events: enlaces externos. Solo se guarda el HASH del token; caducidad obligatoria (≤ 30 días);
--     nunca recursos del Vault (trigger). Los visitantes externos NO tocan tablas: solo rutas de servidor que validan el token.
--  2. rate_limits + rate_hit(): contador atómico por clave y ventana (fuerza bruta y límite de peticiones del endpoint público).
--  3. comments: menciones, resuelto con fecha y comentarios EXTERNOS (nombre de visitante + enlace).
--  4. notification_settings / notifications / notification_outbox: preferencias, bandeja interna y cola de correo.

-- ---------------------------------------------------------------------------
-- 1. Enlaces externos
-- ---------------------------------------------------------------------------
create table if not exists public.share_links (
  id                 uuid primary key default gen_random_uuid(),
  token_hash         text not null unique,
  resource_type      text not null check (resource_type in ('session', 'folder', 'asset_set', 'beat_set')),
  resource_id        uuid,
  resource_ids       uuid[],
  title              text not null check (char_length(title) between 1 and 120),
  message            text check (message is null or char_length(message) <= 1000),
  can_download       boolean not null default false,
  can_comment        boolean not null default false,
  password_hash      text,
  expires_at         timestamptz not null,
  max_downloads      integer check (max_downloads is null or max_downloads > 0),
  view_count         integer not null default 0,
  download_count     integer not null default 0,
  first_opened_at    timestamptz,
  expiry_notified_at timestamptz,
  created_by         uuid references public.profiles (id) on delete set null,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  constraint share_links_shape check (
    (resource_type in ('session', 'folder') and resource_id is not null and resource_ids is null)
    or (resource_type in ('asset_set', 'beat_set') and resource_id is null and cardinality(resource_ids) between 1 and 500)
  ),
  -- La caducidad es OBLIGATORIA y como máximo 30 días desde la creación
  constraint share_links_expiry check (expires_at > created_at and expires_at <= created_at + interval '30 days' + interval '5 minutes')
);
create index if not exists share_links_created_by_idx on public.share_links (created_by, created_at desc);
create index if not exists share_links_expiry_idx on public.share_links (expires_at) where revoked_at is null;

create table if not exists public.share_link_events (
  id         uuid primary key default gen_random_uuid(),
  link_id    uuid not null references public.share_links (id) on delete restrict,
  type       text not null check (type in ('open', 'view', 'download', 'password_fail', 'comment')),
  ip_hash    text,
  user_agent text check (user_agent is null or char_length(user_agent) <= 80),
  created_at timestamptz not null default now()
);
create index if not exists share_link_events_link_idx on public.share_link_events (link_id, created_at desc);
create index if not exists share_link_events_fail_idx on public.share_link_events (link_id, ip_hash, created_at desc) where type = 'password_fail';

-- Solo inserción (como activity_log)
create or replace function public.share_link_events_append_only()
returns trigger language plpgsql set search_path = ''
as $$
begin
  raise exception 'share_link_events es de solo inserción' using errcode = 'P0001';
end $$;
drop trigger if exists share_link_events_append_only on public.share_link_events;
create trigger share_link_events_append_only before update or delete on public.share_link_events
  for each row execute function public.share_link_events_append_only();
drop trigger if exists share_link_events_no_truncate on public.share_link_events;
create trigger share_link_events_no_truncate before truncate on public.share_link_events
  for each statement execute function public.share_link_events_append_only();

-- Nada del Vault se comparte por enlace (también a nivel de base de datos, además del rechazo en servidor)
create or replace function public.share_links_no_vault()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.resource_type = 'folder' and exists (select 1 from public.folders f where f.id = new.resource_id and f.space = 'vault') then
    raise exception 'Una carpeta del Vault no se puede compartir por enlace' using errcode = 'P0001';
  end if;
  if new.resource_type = 'asset_set' and exists (select 1 from public.assets a where a.id = any (new.resource_ids) and a.space = 'vault') then
    raise exception 'Un archivo del Vault no se puede compartir por enlace' using errcode = 'P0001';
  end if;
  if new.resource_type = 'beat_set' and exists (
    select 1 from public.beats b join public.assets a on a.id = b.asset_id
    where b.id = any (new.resource_ids) and a.space = 'vault') then
    raise exception 'Un archivo del Vault no se puede compartir por enlace' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists share_links_no_vault on public.share_links;
create trigger share_links_no_vault before insert or update of resource_type, resource_id, resource_ids on public.share_links
  for each row execute function public.share_links_no_vault();

alter table public.share_links enable row level security;
alter table public.share_link_events enable row level security;

-- Solo quien gestiona accesos o el creador del enlace; sin políticas de escritura (las escrituras van por acciones de servidor)
drop policy if exists share_links_select on public.share_links;
create policy share_links_select on public.share_links for select to authenticated
  using (created_by = (select auth.uid()) or public.has_permission((select auth.uid()), 'access.manage'));

drop policy if exists share_link_events_select on public.share_link_events;
create policy share_link_events_select on public.share_link_events for select to authenticated
  using (exists (
    select 1 from public.share_links l
    where l.id = share_link_events.link_id
      and (l.created_by = (select auth.uid()) or public.has_permission((select auth.uid()), 'access.manage'))
  ));

revoke all on public.share_links, public.share_link_events from anon, authenticated;
grant select on public.share_links, public.share_link_events to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Límites de peticiones (ventana fija, atómico)
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  key        text not null,
  bucket     bigint not null,
  hits       integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (key, bucket)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

-- true = permitido; false = límite superado en esta ventana
create or replace function public.rate_hit(p_key text, p_window_seconds integer, p_limit integer)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  v_bucket bigint := floor(extract(epoch from now()) / greatest(p_window_seconds, 1));
  v_hits integer;
begin
  insert into public.rate_limits as r (key, bucket, hits, updated_at) values (p_key, v_bucket, 1, now())
  on conflict (key, bucket) do update set hits = r.hits + 1, updated_at = now()
  returning r.hits into v_hits;
  if random() < 0.02 then
    delete from public.rate_limits where updated_at < now() - interval '1 day';
  end if;
  return v_hits <= p_limit;
end $$;
revoke execute on function public.rate_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_hit(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Comentarios: menciones, resuelto con fecha y comentarios externos
-- ---------------------------------------------------------------------------
alter table public.comments add column if not exists mentions uuid[] not null default '{}';
alter table public.comments add column if not exists resolved_at timestamptz;
alter table public.comments add column if not exists external_name text;
alter table public.comments add column if not exists share_link_id uuid references public.share_links (id) on delete restrict;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'comments_external_check') then
    alter table public.comments add constraint comments_external_check
      check (
        (external_name is null) = (share_link_id is null)
        and (external_name is null or (user_id is null and char_length(external_name) between 1 and 60 and cardinality(mentions) = 0))
      );
  end if;
end $$;
update public.comments set resolved_at = created_at where resolved and resolved_at is null;
create index if not exists comments_open_idx on public.comments (created_at desc) where deleted_at is null and parent_id is null and not resolved;
create index if not exists comments_share_link_idx on public.comments (share_link_id) where share_link_id is not null;

-- ---------------------------------------------------------------------------
-- 4. Notificaciones
-- ---------------------------------------------------------------------------
create table if not exists public.notification_settings (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event      text not null,
  channel    text not null default 'email' check (channel in ('email', 'off')),
  frequency  text not null default 'instant' check (frequency in ('instant', 'daily')),
  updated_at timestamptz not null default now(),
  primary key (user_id, event)
);

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  group_key  text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index if not exists notifications_group_idx on public.notifications (user_id, group_key, created_at desc) where group_key is not null;

-- Cola de correo: instantáneos y resumen diario. Solo el servidor (service role) la lee y la escribe.
create table if not exists public.notification_outbox (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  event      text not null,
  frequency  text not null check (frequency in ('instant', 'daily')),
  group_key  text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts   integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists notification_outbox_pending_idx on public.notification_outbox (frequency, created_at) where status = 'pending';
create index if not exists notification_outbox_group_idx on public.notification_outbox (user_id, group_key, sent_at desc) where status = 'sent';

alter table public.notification_settings enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_outbox enable row level security;

drop policy if exists notification_settings_select on public.notification_settings;
create policy notification_settings_select on public.notification_settings for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.notification_settings, public.notifications, public.notification_outbox from anon, authenticated;
grant select on public.notification_settings, public.notifications to authenticated;
grant select, insert, update, delete on public.share_links, public.share_link_events, public.rate_limits,
  public.notification_settings, public.notifications, public.notification_outbox to service_role;

revoke execute on function public.share_link_events_append_only(), public.share_links_no_vault() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Contadores atómicos de enlaces (los llama solo el servidor)
-- ---------------------------------------------------------------------------
-- Cuenta una apertura; devuelve true SOLO la primera vez que se abre el enlace.
create or replace function public.share_register_open(p_link uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare v_first boolean;
begin
  select first_opened_at is null into v_first from public.share_links where id = p_link and revoked_at is null and expires_at > now() for update;
  if not found then return false; end if;
  update public.share_links set view_count = view_count + 1, first_opened_at = coalesce(first_opened_at, now()) where id = p_link;
  return v_first;
end $$;

-- Cuenta una descarga si el enlace sigue vivo y no ha llegado al límite; devuelve false si no hay cupo.
create or replace function public.share_register_download(p_link uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  update public.share_links set download_count = download_count + 1
  where id = p_link and revoked_at is null and expires_at > now() and can_download
    and (max_downloads is null or download_count < max_downloads);
  return found;
end $$;

revoke execute on function public.share_register_open(uuid), public.share_register_download(uuid) from public, anon, authenticated;
grant execute on function public.share_register_open(uuid), public.share_register_download(uuid) to service_role;
