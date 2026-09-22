# Arquitectura de TriggerBOT

Guía técnica de cómo funciona cada sistema. Para el uso (comandos, configuración, deploy), ver el [README](../README.md).

El bot es JavaScript CommonJS sobre Node 18+, con **tres dependencias de runtime**: `discord.js`, `dotenv` y `mysql2` (pool MariaDB). Todo lo demás (logger, tests, lint) corre con herramientas nativas o devDependencies.

## Mapa de módulos

| Módulo | Responsabilidad |
|---|---|
| `src/index.js` | Punto de entrada: carga comandos/eventos, sesión con reintentos, apagado controlado |
| `src/commandLoader.js` | **Única** fuente de carga de comandos (la usan el runtime y `deploy-commands.js`) |
| `src/store.js` | Config por servidor (`data/config.json`) + marcas de cambio por guild |
| `src/warns.js` | Historial de advertencias (`data/warns.json`) |
| `src/niveles.js` | XP, niveles, logros, rangos (`data/niveles.json`) con escritura con debounce |
| `src/commands/afk.js` | Estado AFK (`data/afk.json`) |
| `src/utils/interacciones.js` | Contadores de interacciones (`data/interacciones.json`) |
| `src/db/mariadb.js` | Cliente MySQL/MariaDB (pool, sin ORM): subir/descargar/listar/ping + creación de tablas bot_ |
| `src/db/puente.js` | Bus de comandos web ↔ bot vía la tabla `bot_cmd` |
| `src/db/sync.js` | Respaldo y restauración guild-por-guild con debounce |
| `src/logger.js` | Logger estructurado con sanitización de secretos |
| `src/utils/moderation.js` | Validaciones de jerarquía compartidas |
| `src/utils/proteccion.js` | Anti-spam y anti-raid automáticos |
| `src/utils/accionesIA.js` | Acciones de moderación pedidas por IA (confirmación con botones) |
| `src/utils/tickets.js` | Sistema de tickets con transcript |
| `src/utils/modlog.js` | Registro numerado de casos de moderación |
| `src/utils/log.js` | Logs generales de eventos (mensajes borrados/editados, ingresos, etc.) |
| `src/utils/replies.js` | Embeds y formato con el estilo visual del bot |

## Flujo de arranque (`index.js`)

1. `dotenv` carga `.env` (las variables del panel de Wispbyte no se pisan).
2. `commandLoader.cargarComandos()` carga **44 comandos**: los 35 archivos de `src/commands/`, los 8 generados por `fabricaInteracciones.js` (/beso, /abrazo…) y `/moneda`. `deploy-commands.js` usa la misma función, así el registro y el runtime nunca difieren.
3. Se cargan los eventos de `src/events/` (un archivo por evento).
4. `sync.restaurar()` compara cada servidor con la base (ver [Respaldo en la base](#respaldo-en-la-base-dbsyncjs--dbmariadbjs)) y aplica la copia más nueva guild por guild. `mariadb.js` crea las tablas `bot_*` si no existen.
5. `mariadb.ping()` prueba lectura y escritura; si el usuario no puede escribir (GRANT), avisa con la solución exacta.
6. `client.login()` con vigilante: si Discord no responde en 45 s (típico bloqueo de IP del nodo), destruye el cliente y reintenta cada 60 s.

## Jerarquía y permisos (`moderation.js`)

Dos funciones puras, usadas por comandos, protección y acciones de IA:

- **`motivoNoModerable(interaction, member)`** → jerarquía *moderador → objetivo*: existe, no es uno mismo, no es el bot, y su rol más alto es estrictamente inferior al del moderador (salvo que el moderador sea el dueño del server).
- **`validarAccionDelBot(guild, member, permiso)`** → jerarquía *bot → objetivo*: miembro existe, no es el bot ni el dueño, el bot tiene el **permiso concreto** (`PermissionFlagsBits.*`) y el rol del objetivo queda por debajo del del bot. Los permisos no compensan jerarquía: un admin con rol bajo no habilita acciones sobre alguien más alto que el bot.

Ambas devuelven `null` si todo está bien o un mensaje de error listo para mostrar.

## Acciones de moderación por IA (`accionesIA.js`)

1. La IA puede responder un JSON de acción (`{accion, objetivo, motivo, duracion_min}`) cuando el usuario pide algo como "@TriggerBOT muteá a @fulano".
2. `pedirConfirmacion()` muestra el embed con botones. **Solo staff** (permisos de moderación o roles admin/mod/helper de `/config`) puede ejecutar; expiran a los 5 minutos.
3. Al confirmar, `validarAccionIA()` **revalida todo** contra la realidad del momento: objetivo existe, no es el dueño ni el bot, jerarquía contra quien confirma, permiso concreto del bot (incluye el caso mute-sin-rol → timeout). No confía en lo que la IA pidió hace minutos.
4. Cada acción verifica su resultado real; el mod-log registra lo que pasó (no lo que se intentó).

## Protección automática (`proteccion.js`)

**Anti-spam** (por mensaje, en `messageCreate`):
- Ventana móvil por usuario (`guildId:userId` → stamps). Umbral configurable (`spamMensajes` en `spamSegundos`, por defecto 5 en 5).
- Exentos: quien puede gestionar mensajes o el guild (staff).
- Al superar el umbral: borra la ráfaga (agrupada por canal, `force=true` para mensajes viejos), ejecuta la acción configurada y avisa por DM + canal de staff. Cooldown de 30 s entre castigos al mismo usuario.
- **Resultado honesto**: cada acción devuelve `{ ok, error }` y el embed muestra `⚠️ ... falló: <motivo de Discord>` si fue rechazada. El fallback de mute (sin rol de silenciado) **ejecuta de verdad** un timeout de 10 minutos.

**Anti-raid** (por ingreso, en `guildMemberAdd`):
- Ventana por guild (`raidJoins` ingresos en `raidSegundos`, por defecto 8 en 60). Siempre alerta al staff con la lista de ingresos y marca cuentas de menos de 7 días 🆕.
- La auto-acción (opcional, apagada por defecto) solo toca cuentas nuevas **sin roles** y nunca bots; si Discord rechaza, el resumen lo cuenta (`N rechazada(s) por Discord`).
- Estado 100 % en memoria a propósito: un reinicio limpia ventanas y cooldowns, no hay datos sensibles que perder.

## Niveles (`niveles.js`)

- XP base 15-25 por mensaje con cooldown de 60 s (anti-farm). Bonus acumulables: racha (+1 %/día, tope 35 %), noche (+10 %, 00-06 h Argentina), finde (x2, sáb/dom).
- Nivel = `floor(0.1 * sqrt(xp))` (curva cuadrática); 16 logros con premio de XP que pueden encadenar subidas de nivel.
- **Escritura con debounce de 5 s**: `procesarMensaje()` deja todo en memoria y agenda el guardado; nunca escribe a disco por mensaje. `volcar()` fuerza el guardado (lo llama el apagado).

## Persistencia local (los 5 almacenes)

`store`, `warns`, `niveles`, `afk` e `interacciones` comparten mecánica:

- JSON en disco con **escritura atómica** (`archivo.tmp` + `rename`): un corte de luz no corrompe el archivo.
- Caché en memoria; el disco es la copia de respaldo.
- **`marcasPorGuild()`**: timestamp del último cambio **por servidor**, actualizado en cada mutación real. Es lo que compara la restauración con la nube (reemplaza al viejo mtime compartido del archivo).
- Directorio configurable con `TRIGGER_DATA_DIR` (lo usan los tests para correr aislados).

## Respaldo en la base (`db/sync.js` + `db/mariadb.js`)

- El bot comparte la base MariaDB de la web (trigger-arena-db) pero usa **sus propias tablas con prefijo `bot_`** (`bot_data`, `bot_stats`, `bot_cmd`), que crea solo con `CREATE TABLE IF NOT EXISTS` al primer uso. Nunca consulta ni escribe tablas de la web; las consultas van **parametrizadas** (placeholders `?`) y la tabla/columna se valida contra una whitelist.
- `mariadb.js` usa `mysql2/promise` con un pool de 5 conexiones, reintentos del driver y detección de errores de permisos (GRANT).
- Cada guardado local agenda la subida del almacén afectado con **debounce de 3 s** (`marcarSucio`): una ráfaga de mensajes = una subida.
- **Restauración guild-por-guild**: para cada fila de la base compara `version` (timestamp de la subida) contra la marca local de *ese* servidor. Base más nueva → restaura y actualiza la marca interna; local igual o más nuevo → se sube. Un servidor ya no pisa los datos restaurados de otro y un host nuevo puede descargar todo.
- `subirYa()` para avisos importantes (bot expulsado del server) y `guildDelete.js` agenda la limpieza de sus datos en ambos lados con 60 s de gracia (por si fue un reinicio con re-invitación).
- El puente web (`db/puente.js`) usa la tabla `bot_cmd` como bus de comandos: la web inserta, el bot procesa cada 5 s y marca `procesado_en` + `resultado`.

## Apagado controlado (`index.js`)

`SIGTERM`/`SIGINT` (Wispbyte manda SIGTERM al reiniciar):

1. Log de inicio del apagado (idempotente: la segunda señal corta directo).
2. `volcarTodo()`: fuerza el guardado a disco de los almacenes con debounce (niveles sobre todo).
3. `esperarSubidasPendientes()`: espera hasta 10 s a que las subidas a la base con debounce terminen.
4. `client.destroy()`, cierre del pool de MariaDB y `process.exit(0)`.

Sin esto, un reinicio del host perdía hasta 5 s de XP y 3 s de subidas.

## Logger (`logger.js`)

```
[TriggerBOT] [WARN] [mariadb] Fallo al subir config:g123 {"clave":"config:g123"}
```

- Niveles `debug|info|warn|error`, mínimo configurable con `LOG_LEVEL` (default `info`).
- **Sanitización automática**: si `DISCORD_TOKEN` o `DB_PASSWORD` terminan dentro de un mensaje de error, se reemplazan por `[REDACTADO]`.
- `log.error('Fallo', error, { guild, usuario })` agrega contexto plano; el stack completo solo sale en `LOG_LEVEL=debug`.

## Chat con IA (`utils/ia.js`)

- Cadena Groq → Gemini → repertorio local. Si un proveedor falla o un modelo fue retirado (404), lo saca de la lista y sigue (autorreparación).
- Memoria por usuario: últimos 6 turnos, TTL de 10 minutos, limpieza periódica del Map. La clave es `userId` (bot de un solo server; si se usara en varios, habría que particionar por `guildId:userId`).
- **Qué se envía al proveedor**: el mensaje del usuario, nombre mostrado del autor y canal (en el prompt de sistema), y el historial reciente (hasta 6 turnos de ese usuario). No se envían IDs de Discord ni contenido de otros usuarios.
- **Cómo limitarlo**: no configurar `GROQ_API_KEY`/`GEMINI_API_KEY` desactiva el chat externo (queda el repertorio local). Con la IA activa, esos datos salen del host hacia el proveedor elegido.

## Tickets (`utils/tickets.js`)

- Apertura con **bloqueo por usuario**: dos clics casi simultáneos no crean dos canales (el segundo ve el bloqueo activo y no hace nada).
- Transcript .txt hasta 50.000 mensajes, enviado al canal de logs y por DM al dueño; el canal se borra 30 s después del cierre.

## Tests (`tests/`)

- Runner **nativo de Node** (`node --test`), cero dependencias. `npm test`.
- Cada archivo setea `TRIGGER_DATA_DIR` a un directorio temporal → corre aislado del `data/` real.
- **Fakes, no mocks de librería**: guilds/miembros/interacciones son objetos literales con las propiedades que el código toca; el pool de mysql2 se reemplaza en el require-cache para simular la base (mapa en memoria).
- Cobertura actual:
  - `moderation.test.js` — jerarquía moderador→objetivo y bot→objetivo (el caso "admin con rol bajo").
  - `proteccion.test.js` — detección de spam, ventana, exención de staff, cooldown; acciones con resultado real; raid con auto-acción selectiva.
  - `niveles.test.js` — XP, cooldown, bonus, racha, logros no repetibles, debounce (procesar mensaje **no** escribe a disco), warns.
  - `sync.test.js` — decisiones de restauración por guild (nube nueva, local nuevo, guild a guild), bug original del mtime, debounce de subida, integración con almacenes reales.

## Lint y formato

- **ESLint 9** (flat config, `eslint.config.js`): errores reales, no estilo. `npm run lint`.
- **Prettier 3** (`.prettierrc.json`, líneas de 150, comillas simples): `npm run format`.
- `npm run check` = lint + tests, el mínimo antes de subir cambios.

## Convenciones para cambios futuros

1. **Comandos nuevos**: un archivo en `src/commands/` con `data` y `execute`; se carga y registra solo.
2. **Toda acción de moderación** pasa por `validarAccionDelBot` (automática) o `motivoNoModerable` + `validarAccionIA` (IA) y verifica el resultado de Discord.
3. **Ningún módulo escribe a disco en caliente**: mutación → caché → `tocarMarca(guildId)` → `marcarSucio(...)`; el disco con debounce y `volcar()` en el apagado.
4. **Nada de secretos en logs**: pasar errores por el logger (sanitiza solo).
5. **Funciones puras para lógica decidible** (jerarquía, comparaciones de sync): son las que se testean sin red ni disco.
