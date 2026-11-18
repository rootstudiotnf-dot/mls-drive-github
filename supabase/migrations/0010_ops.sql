-- =============================================================================
-- MLS Drive — Fase 10: operación (copias de seguridad y avisos)
-- =============================================================================
-- Idempotente. Solo dos tablas de uso EXCLUSIVO del servidor (RLS activada, sin políticas, sin privilegios para
-- los clientes): el registro de cada copia de seguridad (para «/admin/estado» y las alertas) y el control de
-- avisos al owner (para no repetir el mismo aviso una y otra vez). No cambia ninguna regla de acceso.

create table if not exists public.backup_runs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('db', 'files', 'vault')),
  status     text not null check (status in ('ok', 'partial', 'failed')),
  -- Solo cifras (objetos, bytes, errores): nunca nombres ni claves de objeto
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists backup_runs_kind_idx on public.backup_runs (kind, created_at desc);

create table if not exists public.ops_alerts (
  key          text primary key,
  last_sent_at timestamptz not null default now(),
  last_state   text
);

alter table public.backup_runs enable row level security;
alter table public.ops_alerts enable row level security;
revoke all on public.backup_runs from anon, authenticated;
revoke all on public.ops_alerts from anon, authenticated;

-- Errores del servidor y del navegador (solo nombre y código: NUNCA mensajes, datos de personas ni tokens).
-- Se leen en «/admin/estado» (solo owner) y se purgan pasados 14 días.
create table if not exists public.error_log (
  id         uuid primary key default gen_random_uuid(),
  scope      text not null check (char_length(scope) between 1 and 40),
  name       text not null check (char_length(name) between 1 and 80),
  code       text check (code is null or char_length(code) <= 40),
  created_at timestamptz not null default now()
);
create index if not exists error_log_created_idx on public.error_log (created_at desc);
alter table public.error_log enable row level security;
revoke all on public.error_log from anon, authenticated;
