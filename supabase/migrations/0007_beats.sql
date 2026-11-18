-- MLS Drive — Fase 7: Beat Library (catálogo, reproductor, datos del beat y compartir)
--
-- REAPLICABLE (idempotente). Cambios sobre la Fase 2 limitados a lo indicado para `beats`:
--   · `can_access`: el alcance de un beat incluye los artistas con los que está compartido (`beat_artists`), el audio
--     y la portada de un beat se autorizan A TRAVÉS del beat, y descargar el original exige 3 capas
--     (rol `beats.download` + `beats.downloadable` + `can_download` del artista o grant con descarga; salvo alcance «all»).
-- (La petición original numeraba esta migración como 0006; esa numeración ya la usa la Fase 6.)

-- ---------------------------------------------------------------------------
-- video_jobs → media_jobs (vídeo y audio), conservando los datos
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.video_jobs') is not null and to_regclass('public.media_jobs') is null then
    alter table public.video_jobs rename to media_jobs;
  end if;
end $$;

alter table public.media_jobs add column if not exists kind text not null default 'video';
alter table public.media_jobs drop constraint if exists media_jobs_kind_check;
alter table public.media_jobs add constraint media_jobs_kind_check check (kind in ('video', 'audio'));

alter index if exists public.video_jobs_one_active_per_asset rename to media_jobs_one_active_per_asset;
alter index if exists public.video_jobs_asset_idx rename to media_jobs_asset_idx;
alter index if exists public.video_jobs_pending_idx rename to media_jobs_pending_idx;

drop policy if exists video_jobs_select on public.media_jobs;
drop policy if exists media_jobs_select on public.media_jobs;
create policy media_jobs_select on public.media_jobs for select to authenticated
  using (public.has_admin_permission());

-- Regla de publicación de vídeo (ahora contra media_jobs)
create or replace function public.enforce_video_ready_to_publish()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.visibility = 'published' and old.visibility is distinct from 'published' and new.kind = 'video' then
    if not exists (select 1 from public.media_jobs j where j.asset_id = new.id and j.status = 'ready') then
      raise exception 'El vídeo aún no está procesado: no se puede publicar' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- beats: forma de onda, preview con tag, búsqueda de texto completo
-- ---------------------------------------------------------------------------
alter table public.beats add column if not exists waveform jsonb;
alter table public.beats add column if not exists preview_tagged boolean not null default false;
alter table public.beats add column if not exists search tsvector;

-- Normaliza para buscar sin tildes ni mayúsculas
create or replace function public.search_norm(p_text text)
returns text language sql immutable set search_path = ''
as $$ select translate(lower(coalesce(p_text, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc') $$;

create or replace function public.beat_search_vector(p_title text, p_genre uuid, p_beat uuid)
returns tsvector language sql stable set search_path = ''
as $$
  select to_tsvector('simple', public.search_norm(
    coalesce(p_title, '') || ' ' ||
    coalesce((select g.name from public.genres g where g.id = p_genre), '') || ' ' ||
    coalesce((select string_agg(t.name, ' ') from public.taggings tg join public.tags t on t.id = tg.tag_id
              where tg.resource_type = 'beat' and tg.resource_id = p_beat), '')
  ))
$$;

create or replace function public.beats_set_search()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.search := public.beat_search_vector(new.title, new.genre_id, new.id);
  return new;
end $$;
drop trigger if exists beats_set_search on public.beats;
create trigger beats_set_search before insert or update of title, genre_id on public.beats
  for each row execute function public.beats_set_search();

-- Al cambiar las etiquetas de un beat o el nombre de un género se refresca el índice de búsqueda
create or replace function public.beats_refresh_search_from_tagging()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_resource uuid; v_type text;
begin
  v_type := coalesce(new.resource_type, old.resource_type);
  v_resource := coalesce(new.resource_id, old.resource_id);
  if v_type = 'beat' then
    update public.beats b set search = public.beat_search_vector(b.title, b.genre_id, b.id) where b.id = v_resource;
  end if;
  return null;
end $$;
drop trigger if exists taggings_refresh_beat_search on public.taggings;
create trigger taggings_refresh_beat_search after insert or delete on public.taggings
  for each row execute function public.beats_refresh_search_from_tagging();

create or replace function public.genres_refresh_beat_search()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.name is distinct from old.name then
    update public.beats b set search = public.beat_search_vector(b.title, b.genre_id, b.id) where b.genre_id = new.id;
  end if;
  return null;
end $$;
drop trigger if exists genres_refresh_beat_search on public.genres;
create trigger genres_refresh_beat_search after update of name on public.genres
  for each row execute function public.genres_refresh_beat_search();

-- Índice de búsqueda de los beats que ya existían
update public.beats b set search = public.beat_search_vector(b.title, b.genre_id, b.id) where b.search is null;

-- ---------------------------------------------------------------------------
-- Publicar un beat exige datos completos y preview listo
-- ---------------------------------------------------------------------------
create or replace function public.enforce_beat_ready_to_publish()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    if coalesce(trim(new.title), '') = '' or new.bpm is null or new.musical_key is null or new.genre_id is null then
      raise exception 'Para publicar hacen falta título, BPM, tonalidad y género' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.media_jobs j where j.asset_id = new.asset_id and j.kind = 'audio' and j.status = 'ready') then
      raise exception 'El preview del beat aún no está listo: no se puede publicar' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists beats_ready_to_publish on public.beats;
create trigger beats_ready_to_publish before update of status on public.beats
  for each row execute function public.enforce_beat_ready_to_publish();

-- ---------------------------------------------------------------------------
-- beat_artists: beats compartidos con un artista
-- ---------------------------------------------------------------------------
create table if not exists public.beat_artists (
  beat_id      uuid not null references public.beats (id) on delete cascade,
  artist_id    uuid not null references public.artists (id) on delete cascade,
  can_download boolean not null default false,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (beat_id, artist_id)
);
create index if not exists beat_artists_artist_id_idx on public.beat_artists (artist_id);

-- Ajustes (solo owner): tag de voz de los previews
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.beat_artists enable row level security;
alter table public.app_settings enable row level security;

-- Cada artista ve SUS compartidos (por sus asignaciones); quien edita beats, todos
drop policy if exists beat_artists_select on public.beat_artists;
create policy beat_artists_select on public.beat_artists for select to authenticated
  using (
    exists (select 1 from public.artist_members m where m.artist_id = beat_artists.artist_id and m.user_id = (select auth.uid()))
    or public.has_permission((select auth.uid()), 'beats.edit')
    or public.has_admin_permission()
  );

drop policy if exists app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated
  using (public.current_role_key() = 'owner');

revoke all on public.beat_artists, public.app_settings from anon, authenticated;
grant select on public.beat_artists, public.app_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Índices del catálogo
-- ---------------------------------------------------------------------------
create index if not exists beats_status_created_idx on public.beats (status, created_on desc, id desc) where deleted_at is null;
create index if not exists beats_search_idx on public.beats using gin (search);
create index if not exists beats_genre_idx on public.beats (genre_id) where deleted_at is null;
create index if not exists beats_created_idx on public.beats (created_on desc, id desc) where deleted_at is null;
create index if not exists beats_bpm_idx on public.beats (bpm asc nulls last, id asc) where deleted_at is null;
create index if not exists beats_musical_key_idx on public.beats (musical_key) where deleted_at is null;
create index if not exists beats_title_idx on public.beats (lower(title), id) where deleted_at is null;
create index if not exists taggings_resource_idx on public.taggings (resource_type, resource_id);
create index if not exists taggings_tag_idx on public.taggings (tag_id, resource_type);

-- ---------------------------------------------------------------------------
-- can_access (Fase 2/5) con los cambios de la Fase 7 (marcados con «Fase 7»)
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
    if a.artist_id is not null and exists (
         select 1 from public.artists x where x.id = a.artist_id and x.deleted_at is not null) then return false; end if;
    if a.session_id is not null and exists (
         select 1 from public.sessions x where x.id = a.session_id and x.deleted_at is not null) then return false; end if;
    v_asset := a.id; v_artist := a.artist_id; v_session := a.session_id; v_folder := a.folder_id;
    v_is_vault := (a.space = 'vault');
    v_area := case when v_is_vault then 'vault'
                   when a.kind = 'photo' then 'photos'
                   when a.kind = 'video' then 'videos'
                   else 'files' end;
    v_visibility := a.visibility::text; v_uploaded_by := a.uploaded_by; v_downloadable := a.downloadable;

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
    if exists (select 1 from public.artists x where x.id = f.artist_id and x.deleted_at is not null) then
      return false;
    end if;
    v_folder := f.id; v_artist := f.artist_id;
    v_session := f.session_id; -- Fase 5: una carpeta de sesión hereda el acceso de la sesión
    v_area := case when f.kind = 'photos' then 'photos' when f.kind = 'videos' then 'videos' else 'files' end;

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
    if v_role_key <> 'owner' and not exists (
      select 1 from public.grants g
      where g.user_id = p_user and g.resource_type = 'vault' and g.revoked_at is null
        and (g.expires_at is null or g.expires_at > now())
        and public.grant_allows(g, p_action)
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

-- ---------------------------------------------------------------------------
-- Catálogo paginado por cursor (SECURITY INVOKER: RLS/can_access decide qué beats ve cada persona)
--   p_order: 'recent' (fecha desc) · 'name' (título asc) · 'bpm' (bpm asc, sin bpm al final)
--   cursor: (p_after_val, p_after_id) = valor de orden e id del último elemento de la página anterior
-- ---------------------------------------------------------------------------
create or replace function public.beat_catalog(
  p_q text default null,
  p_genres uuid[] default null,
  p_bpm_min integer default null,
  p_bpm_max integer default null,
  p_keys text[] default null,
  p_tags uuid[] default null,
  p_status text default null,
  p_artist uuid default null,
  p_order text default 'recent',
  p_after_val text default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid, asset_id uuid, title text, bpm integer, musical_key text, genre_id uuid, genre_name text,
  status text, created_on date, downloadable boolean, cover_asset_id uuid, duration_seconds numeric,
  preview_ready boolean, tags text[], sort_val text
)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_query tsquery;
  v_sort text;
  v_cmp text;
  v_order text;
begin
  if p_q is not null and length(trim(p_q)) > 0 then
    -- cada palabra como prefijo: «bou» encuentra «bounce»
    select to_tsquery('simple', string_agg(quote_literal(w) || ':*', ' & '))
      into v_query
    from (select regexp_split_to_table(public.search_norm(regexp_replace(trim(p_q), '[^[:alnum:] ]', ' ', 'g')), '\s+') as w) x
    where w <> '';
  end if;

  -- Orden y cursor sobre columnas reales (no sobre expresiones de texto): así un índice sirve el orden y el LIMIT
  -- se detiene a los 50 primeros visibles, en vez de evaluar can_access sobre todo el catálogo para ordenarlo.
  if p_order = 'name' then
    v_sort := 'lower(b.title)';
    v_order := 'lower(b.title) asc, b.id asc';
    v_cmp := '(lower(b.title), b.id) > ($1, $2)';
  elsif p_order = 'bpm' then
    v_sort := 'coalesce(b.bpm::text, '''')';
    v_order := 'b.bpm asc nulls last, b.id asc';
    v_cmp := '(($1 = '''' and b.bpm is null and b.id > $2) or ($1 <> '''' and (b.bpm > $1::integer or (b.bpm = $1::integer and b.id > $2) or b.bpm is null)))';
  else
    v_sort := 'to_char(b.created_on, ''YYYY-MM-DD'')';
    v_order := 'b.created_on desc, b.id desc';
    v_cmp := '(b.created_on, b.id) < ($1::date, $2)';
  end if;

  -- Etiquetas y artista como semiuniones: el planificador puede empezar por las filas que coinciden (índices de
  -- taggings / beat_artists) y evaluar can_access solo sobre ellas.
  return query execute format($f$
    select b.id, b.asset_id, b.title, b.bpm, b.musical_key, b.genre_id, g.name, b.status::text, b.created_on,
           b.downloadable, b.cover_asset_id, a.duration_seconds,
           exists (select 1 from public.asset_derivatives d where d.asset_id = b.asset_id and d.type = 'audio_preview' and d.status = 'ready'),
           coalesce((select array_agg(t.name order by t.name) from public.taggings tg join public.tags t on t.id = tg.tag_id
                     where tg.resource_type = 'beat' and tg.resource_id = b.id), array[]::text[]),
           %1$s
    from public.beats b
    left join public.genres g on g.id = b.genre_id
    left join public.assets a on a.id = b.asset_id
    where b.deleted_at is null
      and ($3::tsquery is null or b.search @@ $3::tsquery)
      and ($4::uuid[] is null or b.genre_id = any($4))
      and ($5::integer is null or b.bpm >= $5)
      and ($6::integer is null or b.bpm <= $6)
      and ($7::text[] is null or b.musical_key = any($7))
      and ($8::text is null or b.status::text = $8)
      and ($9::uuid is null or b.id in (select ba.beat_id from public.beat_artists ba where ba.artist_id = $9))
      and ($10::uuid[] is null or b.id in (
            select tg.resource_id from public.taggings tg
            where tg.resource_type = 'beat' and tg.tag_id = any($10)
            group by tg.resource_id having count(distinct tg.tag_id) = cardinality($10)))
      and ($1::text is null or %2$s)
    order by %3$s
    limit $11
  $f$, v_sort, v_cmp, v_order)
  using p_after_val, p_after_id, v_query, p_genres, p_bpm_min, p_bpm_max, p_keys, p_status, p_artist, p_tags, v_limit;
end $$;

revoke execute on function
  public.beat_catalog(text, uuid[], integer, integer, text[], uuid[], text, uuid, text, text, uuid, integer),
  public.enforce_beat_ready_to_publish(), public.beats_set_search(), public.beats_refresh_search_from_tagging(),
  public.genres_refresh_beat_search(), public.beat_search_vector(text, uuid, uuid)
from public, anon, authenticated;
grant execute on function public.beat_catalog(text, uuid[], integer, integer, text[], uuid[], text, uuid, text, text, uuid, integer) to authenticated;
