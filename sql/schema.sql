-- ============================================================================
-- TriggerBOT — Esquema de base de datos para MariaDB/MySQL
--
-- La web (TriGGer.Arena) y el bot comparten la MISMA base (trigger-arena-db).
-- El bot usa SUS PROPIAS tablas con prefijo bot_ y NO toca ninguna tabla de la
-- web (actividad, avisos, usuarios, partidos, productos, etc.).
--
-- No hace falta correrlo a mano: el bot crea estas tablas solo al arrancar
-- (CREATE TABLE IF NOT EXISTS en src/db/mariadb.js). Este archivo queda como
-- referencia y por si el hosting exige crearlas desde phpMyAdmin.
--
-- Idempotente: podés correrlo varias veces sin romper nada.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tabla principal: un snapshot JSON por cada "almacén" de datos del bot
-- (config, warns, niveles, afk, interacciones) para cada servidor.
-- MariaDB 10.6 no tiene tipo JSON real: los JSON van como LONGTEXT y el bot
-- los serializa/deserializa (JSON.stringify / JSON.parse en src/db/mariadb.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_data (
  clave VARCHAR(100) NOT NULL PRIMARY KEY,        -- ej: "config:972931405548912690"
  guild_id VARCHAR(32) NOT NULL,                  -- ID del servidor de Discord
  almacen VARCHAR(32) NOT NULL,                   -- config | warns | niveles | afk | interacciones
  datos LONGTEXT NOT NULL,                        -- el contenido completo de ese almacén (JSON)
  actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  version BIGINT NOT NULL DEFAULT 0,              -- Date.now() de la subida (resuelve conflictos)
  INDEX bot_data_guild_idx (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Estadísticas globales del bot (claves sueltas: contadores de IA, ping, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_stats (
  clave VARCHAR(100) NOT NULL PRIMARY KEY,
  valor LONGTEXT NOT NULL,                        -- JSON
  actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Puente web ↔ bot: la web (TriGGer.Arena) inserta comandos acá y el bot los
-- procesa cada 5 s, guarda el resultado y publica su estado en bot_data
-- (clave "bot_estado:_global"). La autenticación de ambos lados es el usuario
-- MySQL de la base (DB_USER/DB_PASSWORD), mismo que ya usa la web.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_cmd (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  comando VARCHAR(64) NOT NULL,                   -- ver src/db/puente.js (whitelist)
  guild_id VARCHAR(32) NULL,                      -- servidor destino (NULL = global)
  argumentos LONGTEXT NOT NULL,                   -- JSON
  creada_por VARCHAR(64) NULL,                    -- usuario web que lo envió (auditoría)
  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  procesado_en TIMESTAMP NULL DEFAULT NULL,       -- el bot lo marca al procesarlo
  resultado LONGTEXT NULL,                        -- JSON { ok, detalle?, error? }
  INDEX bot_cmd_pendientes_idx (procesado_en, creado_en)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nota: no hace falta crear tablas separadas por sistema. El bot escribe el
-- JSON completo de cada almacén, como hoy lo hace en data/*.json. Es simple,
-- a prueba de migraciones y suficiente para este tamaño de proyecto.
-- A diferencia de Supabase, acá no hay RLS: el aislamiento es por usuario de
-- base de datos (el bot usa DB_USER, que solo ve esta base) y por prefijo bot_.
