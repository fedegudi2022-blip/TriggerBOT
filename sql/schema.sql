-- ============================================================================
-- TriggerBOT — Esquema de base de datos para Supabase (PostgreSQL)
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO este archivo → Run.
-- Es idempotente: podés correrlo varias veces sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tabla principal: un snapshot JSON por cada "almacén" de datos del bot
-- (config, warns, niveles, afk, interacciones) para cada servidor.
-- Usamos JSONB: Postgres valida y consulta el JSON de forma nativa.
-- ---------------------------------------------------------------------------
create table if not exists public.bot_data (
  clave       text primary key,              -- ej: "config:972931405548912690"
  guild_id    text not null,                 -- ID del servidor de Discord
  almacen     text not null,                 -- config | warns | niveles | afk | interacciones
  datos       jsonb not null,                -- el contenido completo de ese almacén
  actualizado_en timestamptz not null default now(),
  version     bigint not null default 0      -- se incrementa en cada guardado (resuelve conflictos)
);

-- Índice para consultas por servidor (ej: borrar todo al ser expulsado el bot).
create index if not exists bot_data_guild_idx on public.bot_data (guild_id);

-- ---------------------------------------------------------------------------
-- Estadísticas globales del bot (claves sueltas: contadores de IA, etc.)
-- ---------------------------------------------------------------------------
create table if not exists public.bot_stats (
  clave   text primary key,
  valor   jsonb not null,
  actualizado_en timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seguridad con Row Level Security (RLS):
-- El bot usa la "service role key" (clave de servicio), que bypasea RLS.
-- Las políticas abajo bloquean el acceso con la clave pública (anon):
-- aunque alguien consiga la URL del proyecto, no puede leer ni escribir nada.
-- ---------------------------------------------------------------------------
alter table public.bot_data  enable row level security;
alter table public.bot_stats enable row level security;

drop policy if exists "bloquear_anon" on public.bot_data;
create policy "bloquear_anon" on public.bot_data for all to anon using (false) with check (false);

drop policy if exists "bloquear_anon" on public.bot_stats;
create policy "bloquear_anon" on public.bot_stats for all to anon using (false) with check (false);

-- Nota: no hace falta crear tablas separadas por sistema. El bot escribe el
-- JSON completo de cada almacén, como hoy lo hace en data/*.json. Es simple,
-- a prueba de migraciones y suficiente para este tamaño de proyecto.
