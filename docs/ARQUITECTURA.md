# Arquitectura de TriggerBOT

Guía técnica de cómo funciona cada sistema. Para el uso (comandos, configuración, deploy), ver el [README](../README.md).

El bot es JavaScript CommonJS sobre **Node 22** (fijado en `engines` y en `.nvmrc`; la CI corre en la misma versión), con **tres dependencias de runtime**: `discord.js`, `dotenv` y `mysql2` (pool MariaDB). Todo lo demás (logger, tests, lint) corre con herramientas nativas o devDependencies.

## Mapa de módulos

| Módulo                        | Responsabilidad                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/index.js`                | Punto de entrada: carga comandos/eventos, sesión con reintentos, apagado controlado                       |
| `src/commandLoader.js`        | **Única** fuente de carga de comandos (la usan el runtime y `deploy-commands.js`)                         |
| `src/store.js`                | Config por servidor (`data/config.json`) + marcas de cambio por guild                                     |
| `src/warns.js`                | Historial de advertencias (`data/warns.json`)                                                             |
| `src/notas.js`                | Notas internas del staff (`data/notas.json`), separadas de los warns                                      |
| `src/casos.js`                | Registro persistente de casos de moderación (`data/casos.json`), lo consulta `/casos`                     |
| `src/niveles.js`              | XP, niveles, logros, rangos (`data/niveles.json`) con escritura con debounce                              |
| `src/commands/afk.js`         | Estado AFK (`data/afk.json`)                                                                              |
| `src/utils/interacciones.js`  | Contadores de interacciones (`data/interacciones.json`)                                                   |
| `src/db/mariadb.js`           | Cliente MySQL/MariaDB (pool, sin ORM): subir/descargar/listar/ping + creación de tablas bot_              |
| `src/db/puente.js`            | Bus de comandos web ↔ bot vía la tabla `bot_cmd`                                                          |
| `src/db/sync.js`              | Respaldo y restauración guild-por-guild con debounce                                                      |
| `src/logger.js`               | Logger estructurado con sanitización de secretos                                                          |
| `src/utils/moderation.js`     | Validaciones de jerarquía compartidas                                                                     |
| `src/utils/acciones.js`       | Plomería de moderación: diferir, resolver miembro, resultado real, límites                                |
| `src/utils/confirmaciones.js` | Confirmar/deshacer reutilizable para acciones destructivas                                                |
| `src/utils/guia.js`           | Guía de `/help` armada desde los comandos + detalle por comando                                           |
| `src/utils/proteccion.js`     | Anti-spam y anti-raid automáticos                                                                         |
| `src/utils/accionesIA.js`     | Acciones de moderación pedidas por IA (confirmación con botones)                                          |
| `src/utils/contexto.js`       | Datos en vivo para el prompt de la IA (ficha del autor, servidores CS, config, catálogo real de comandos) |
| `src/utils/conocimiento.js`   | Base de conocimiento de la IA: busca en `docs/conocimiento/*.md` con BM25 (sin dependencias)              |
| `src/utils/web.js`            | Búsqueda web de la IA sin claves de API (Wikipedia, DuckDuckGo, dólar, clima) con caché y topes           |
| `src/utils/presupuesto.js`    | Presupuesto diario de IA: tope de respuestas por día, contador persistido en `bot_stats`                  |
| `src/utils/vigilancia.js`     | Chequeos de salud (`revisar`) + avisos automáticos al staff (`vigilar`); alimenta `/diag`                 |
| `src/utils/tickets.js`        | Sistema de tickets con transcript                                                                         |
| `src/utils/voz.js`            | Canales de voz temporales Join-to-Create (hub, controles, auto-borrado)                                   |
| `src/utils/modlog.js`         | Registro numerado de casos de moderación                                                                  |
| `src/utils/log.js`            | Logs generales de eventos (mensajes borrados/editados, ingresos, etc.)                                    |
| `src/utils/replies.js`        | Embeds y formato con el estilo visual del bot                                                             |

## Flujo de arranque (`index.js`)

1. `dotenv` carga `.env` (las variables del panel de Wispbyte no se pisan).
2. `commandLoader.cargarComandos()` carga **todos los comandos**: los archivos de `src/commands/`, los 8 generados por `fabricaInteracciones.js` (/beso, /abrazo…) y `/moneda`. `deploy-commands.js` usa la misma función, así el registro y el runtime nunca difieren.
3. Se cargan los eventos de `src/events/` (un archivo por evento).
4. `sync.restaurar()` compara cada servidor con la base (ver [Respaldo en la base](#respaldo-en-la-base-dbsyncjs--dbmariadbjs)) y aplica la copia más nueva guild por guild. `mariadb.js` crea las tablas `bot_*` si no existen.
5. `mariadb.ping()` prueba lectura y escritura; si el usuario no puede escribir (GRANT), avisa con la solución exacta.
6. `client.login()` con vigilante: si Discord no responde en 45 s (típico bloqueo de IP del nodo), destruye el cliente y reintenta cada 60 s.

## Jerarquía y permisos (`moderation.js`)

Dos funciones puras, usadas por comandos, protección y acciones de IA:

- **`motivoNoModerable(interaction, member)`** → jerarquía _moderador → objetivo_: existe, no es uno mismo, no es el bot, y su rol más alto es estrictamente inferior al del moderador (salvo que el moderador sea el dueño del server).
- **`validarAccionDelBot(guild, member, permiso)`** → jerarquía _bot → objetivo_: miembro existe, no es el bot ni el dueño, el bot tiene el **permiso concreto** (`PermissionFlagsBits.*`) y el rol del objetivo queda por debajo del del bot. Los permisos no compensan jerarquía: un admin con rol bajo no habilita acciones sobre alguien más alto que el bot.

Ambas devuelven `null` si todo está bien o un mensaje de error listo para mostrar.

## Acciones de moderación por IA (`accionesIA.js`)

1. La IA puede responder un JSON de acción cuando el usuario pide algo como "@TriggerBOT muteá a @fulano" o "borrá todos los mensajes de este canal". Hay **dos familias**: acciones sobre una **persona** (`{accion, objetivo, motivo, duracion_min}`: warn, timeout, mute, kick, ban) y acciones sobre el **canal** donde se mencionó al bot (`{accion, cantidad|segundos, motivo}`: limpiar, slowmode, bloquear, desbloquear). El detector del prompt (ia.js) le ordena explícitamente NO negarse cuando quien pide es del staff —el caso real era el bot contestando "no tengo permiso para borrar mensajes"— y negarse (en texto, sin JSON) cuando no lo es.
2. `pedirConfirmacion()` muestra el embed con botones. Para las de canal, además, exige que **quien pide** sea del staff: afectan a todos los que están ahí. `puedeConfirmar()` es la única regla de permiso (dueño, staff de `/config`, o el permiso exacto que exige el comando equivalente: Gestionar mensajes para `/clear`, Gestionar canales para `/slowmode` y `/lockdown`) y se aplica dos veces: al pedir y al apretar el botón. Expiran a los 5 minutos.
3. Al confirmar, `validarAccionIA()` **revalida todo** contra la realidad del momento: objetivo existe, no es el dueño ni el bot, jerarquía contra quien confirma y el permiso concreto del bot. Para las de canal, `validarAccionCanal()`: es de texto, el bot puede gestionarlo y tiene el permiso puntual. No confía en lo que la IA pidió hace minutos. **Validación = ejecución:** el mute pide `Gestionar roles` porque ejecuta lo mismo que `/mute` (asegura/crea el rol Silenciado y lo asigna), no un fallback a timeout; alinear ambos lados evita bloquear mutes que el comando equivalente sí puede hacer.
4. Los límites son los de los comandos, y se aplican en la ejecución (no en el prompt): hasta 100 mensajes por vez, nada de más de 14 días en bloque, 0-6 h de modo lento. Un solo mensaje se borra individualmente porque `bulkDelete` exige entre 2 y 100.
5. Cada acción verifica su resultado real; el mod-log registra lo que pasó (no lo que se intentó), con el mismo nombre de acción que usa el comando equivalente (`/clear` y la orden por chat comparten `LIMITE_14_DIAS_MS` desde `utils/acciones.js`).

## Auditoría de moderación (`casos.js` + `/casos`)

- `modlog.logAction()` sigue publicando el embed en el canal configurado y **además** persiste el caso en `data/casos.json` (número, acción, objetivo, moderador, motivo, duración, color, timestamp). El embed se pierde con el scroll y el historial se podía auditar solo a ojo; el registro no.
- `/casos [caso] [usuario]` (staff) muestra un caso puntual por número o el historial de una persona (`casos.obtener()` / `casos.listar()`).

## Notas internas (`notas.js` + `/nota`)

- `/nota agregar|ver|quitar` guarda observaciones del staff **separadas de los warns**: no cuentan para el silencio automático de 3 advertencias, así una observación ("ya se le avisó") nunca sanciona sola.

## Confirmación de acciones destructivas (`confirmaciones.js`)

- `/ban`, `/softban`, `/kick`, `/mute`, `/clear` y `/lockdown bloquear` **no tocan la API al ejecutarse**: validan jerarquía/permisos y muestran un panel efímero con Confirmar/Cancelar (expira en 60 s). Recién al apretar Confirmar corre la acción. `/mute` crea el rol Silenciado dentro de `ejecutar`, así confirmar es lo único que deja un rol nuevo en el servidor.
- Tras aplicarla, `/ban` y `/mute` (y `/lockdown bloquear`) ofrecen **Deshacer** (desbanear / quitar el rol Silenciado / desbloquear) con otro token de 60 s. Un kick o un borrado masivo no se pueden revertir con la API, así que solo confirman. El resultado se anuncia en el canal salvo `silencioso:true`; con `alEnviar`, `/clear` borra su confirmación pública a los 5 s para no dejar el mensaje pegado en el canal.
- Los manejadores de los botones `conf:` y del **autocompletado** se despachan en `index.js` (`command.autocomplete()`): antes el autocompletado de motivos de `/warn`, `/plantillas`, etc. nunca respondía.

## Baneos temporales (`tempbans.js` + `/tempban`)

- `/tempban` acepta `30m`, `12h`, `7d` (sin unidad = minutos, de 1 minuto a 30 días) y pasa por el mismo panel de confirmación que `/ban`, con **Deshacer (desbanear)**.
- Los pendientes viven en la config del server (`c.tempbans`), así que sobreviven reinicios y viajan con el respaldo de MariaDB. Se guardan **recién cuando el baneo salió bien**: un rechazo de Discord no deja una entrada que después "desbanee" a nadie.
- `index.js` corre `procesar()` cada minuto (y a los 20 s del arranque, por si el bot estuvo caído). La pasada desbanea, deja el caso en el mod-log, avisa por DM y borra la entrada.
- **Sin mentir**: si Discord rechaza el desbaneo, la entrada NO se borra: se reintenta en la próxima pasada y, tras 5 intentos, se descarta dejando el caso `Baneo temporal vencido — no se pudo desbanear`. Un baneo que ya no existe (error `10026`, lo levantó el staff a mano) cuenta como terminado.
- `/unban` y el botón Deshacer de `/tempban` cancelan el pendiente (`cancelar()`), así no queda una entrada fantasma.

## Protección automática (`proteccion.js`)

**Anti-spam** (por mensaje, en `messageCreate`):

- Ventana móvil por usuario (`guildId:userId` → stamps). Umbral configurable (`spamMensajes` en `spamSegundos`, por defecto 5 en 5).
- Exentos: quien puede gestionar mensajes o el guild (staff).
- El umbral cubre **todo el rango configurable** (3-20 mensajes): el estado guarda hasta `MAX_MENSAJES_VENTANA` (20), no un 10 fijo que hacía inalcanzable cualquier `spamMensajes > 10`.
- **Poda por ventana**: en cada mensaje se descartan los que ya salieron de `spamSegundos`, así la ráfaga borrada y el conteo son solo los mensajes que cuentan (antes podía borrar mensajes viejos legítimos).
- Al superar el umbral: borra la ráfaga (agrupada por canal, `force=true` para mensajes viejos), ejecuta la acción configurada y avisa por DM + canal de staff. Cooldown de 30 s entre castigos al mismo usuario.
- **`ventanaSpam` acotada**: `limpiarViejo()` descarta entradas sin actividad dentro del rango máximo de ventana (120 s), con throttle (una pasada completa cada 30 s o si el mapa supera 5.000 claves); antes solo se limpiaba al castigar y el mapa podía crecer sin control.
- **Resultado honesto**: cada acción devuelve `{ ok, error }` y el **DM y el embed** muestran lo que realmente pasó (`⚠️ ... falló: <motivo de Discord>`, o que no se pudo borrar por falta de permiso), nunca la acción configurada como si se hubiera aplicado. El fallback de mute (sin rol de silenciado) **ejecuta de verdad** un timeout de 10 minutos.

**Automod por contenido** (por mensaje, en `messageCreate`, antes del anti-spam):

- Cinco filtros independientes, todos apagados por defecto y bajo el mismo interruptor (`proteccion.activado`): `filtroInvites` (links `discord.gg` / `discord.com/invite` / `discord.me`), `filtroLinks` (cualquier URL fuera de `linksPermitidos`, que además cubre los subdominios), `filtroMenciones` (`@everyone`/`@here` siempre, o más de `mencionesMaximas`), `filtroMayusculas` (`mayusculasPorcentaje` de letras en mayúscula en mensajes de `mayusculasMinimo`+ letras) y `filtroRepetidos` (el mismo texto `repetidosVeces` veces seguidas, normalizado: sin mayúsculas, espacios ni caracteres invisibles).
- Los números se **acotan al leer** (`LIMITES_FILTROS`), no solo al guardar: la config también se edita desde la web y a mano.
- Al filtrar: borra el mensaje (agrupado por canal), avisa por DM al autor y deja el caso en el mod-log. **No aplica castigos** (eso es del anti-spam): un link de un miembro nuevo no debería terminar en un ban automático.
- El filtro de repetidos solo mira el **último** mensaje de cada usuario (`ultimoMensaje`) y reinicia el contador si pasó más de 1 minuto sin escribir.
- Avisos con **cooldown de 30 s por usuario y filtro** (`castigadoHasta`): en una ráfaga de links se borra todo, pero el staff recibe un solo aviso. El borrado nunca depende del aviso.
- Igual que el anti-spam, el resultado que se informa es el **real**: si el bot no puede borrar, la alerta lo dice.

**Anti-raid** (por ingreso, en `guildMemberAdd`):

- Ventana por guild (`raidJoins` ingresos en `raidSegundos`, por defecto 8 en 60). Siempre alerta al staff con la lista de ingresos y marca cuentas de menos de 7 días 🆕.
- La auto-acción (opcional, apagada por defecto) solo toca cuentas nuevas **sin roles** y nunca bots; si Discord rechaza, el resumen lo cuenta (`N rechazada(s) por Discord`).
- Estado 100 % en memoria a propósito: un reinicio limpia ventanas y cooldowns, no hay datos sensibles que perder.

## Comandos: slash y de menú contextual

- El catálogo lo arma `commandLoader.js` leyendo `src/commands/*.js` y vive en `client.commands`, indexado por nombre. Conviven dos tipos: **slash** (`SlashCommandBuilder`, tipo 1) y **de menú contextual** (`ContextMenuCommandBuilder`, tipo 2, click derecho sobre un usuario). Cada uno tiene su handler en `index.js` y una sola pregunta los separa: `guia.esSlash()`.
- Los contextuales **no se escriben**: no van en `/help` ni en el catálogo de comandos que ve la IA. Sin el filtro aparecían como `/Ficha de niveles`, que no es algo que exista.
- Los contextuales **no llevan descripción ni opciones** (Discord rechaza el registro si las mandás) y su nombre admite espacios y mayúsculas hasta 32 caracteres: el validador de `tests/registro.test.js` lo sabe por tipo.
- Reusan el comando de siempre: `ctx-ficha.js` llama a `estadisticas.ejecutar(interaction, usuario)` y `ctx-warnings.js` a `warnings.ejecutar(...)`. Ninguna lógica se duplica, así no pueden mostrar cosas distintas que el slash.
- **Batería de contrato** (`tests/comandos-contrato.test.js`): ejecuta todos los comandos contra fakes en tres escenarios (sin permiso, con permiso y sin opciones opcionales) y exige que ninguno tire, que todos contesten y que los de staff avisen en efímero. Los que necesitan infraestructura real están en una lista de excluidos con el motivo a la vista.

## Visibilidad de los comandos en Discord (`permisos.js`)

- Los comandos de staff **no declaran permisos nativos** (`setDefaultMemberPermissions`) a propósito. La autoridad es la política interna de `permisos.js`: dueño, `ManageGuild`, o los roles admin/mod/helper de `/config`; `exigirStaff()` la aplica dentro de `execute()`.
- El motivo es concreto: si `/config` declarara `ManageGuild`, Discord **ocultaría** el comando a un moderador configurado por rol que no tenga ese permiso nativo, aunque `nivelStaff()` lo aceptaría. Declarar el permiso reintroduce el bug que este diseño evita.
- La regla está fijada por tests: `tests/buscar.test.js` y `tests/vigilancia.test.js` exigen `default_member_permissions == null`, así que agregarlo a un comando de staff hace fallar la batería.
- **Consecuencia visible**: un miembro raso ve los comandos de staff en el selector y recibe el aviso efímero de «solo staff» al usarlos. Ocultarlos **no es algo que el bot pueda hacer**: desde 2022 Discord no permite que las aplicaciones administren los overrides de comandos (la API de permisos devuelve `403`). Solo el dueño del servidor, en **Server Settings → Integrations → TriggerBOT**, puede permitir o denegar cada comando por rol —y ahí sí puede habilitar los roles de staff configurados, aunque no tengan permisos nativos—.

## Niveles (`niveles.js`)

- XP base 15-25 por mensaje con cooldown de 60 s (anti-farm). Bonus acumulables: racha (+1 %/día, tope 35 %), noche (+10 %, 00-06 h Argentina), finde (x2, sáb/dom).
- Nivel = `floor(0.1 * sqrt(xp))` (curva cuadrática); 16 logros con premio de XP que pueden encadenar subidas de nivel.
- **Anuncio en un solo mensaje de texto** (`utils/anunciosNivel.js`, nada de embeds): línea 1 qué pasó con la XP que lo causó y el bonus (x2 finde, racha, noche), línea 2 el total y cuánto falta traducido a mensajes, y solo si aplican las líneas de logros agrupados, rol otorgado y cambio de rango. Antes era un embed por logro más el de nivel: una subida con 3 logros nuevos eran 4 mensajes.
- Los **roles por nivel** (`utils/rolesNivel.js`) se asignan *antes* de anunciar y `asignarRolesNivel()` devuelve solo los que otorgó de verdad, así el anuncio nombra el rol sin prometer uno que Discord rechazó.
- **XP por voz** (`utils/xpVoz.js`): 8 XP por minuto completo en un canal de voz, con tope de 200 XP por usuario y por día. El pago va por **barrido** cada minuto (no por evento): el minuto se cuenta solo si al pagar la persona sigue en el canal y las condiciones se cumplen. Anti-abuso: no paga si está **solo** (un bot no cuenta como compañía), **muteado o sordo**, en el **canal AFK**, en un canal de `voz.canalesSinXP`, ni pasado el tope diario. Mutearse, desmutearse o cambiar de canal **reinicia el minuto** (si no, se cobraba tiempo que no se contó). El estado de presencia es en memoria: un reinicio pierde el minuto en curso y el contador del día, y por eso `sembrar()` vuelve a anotar a quien ya estaba conectado al arrancar. La XP la persiste `niveles.js` con `otorgarXP()`, que devuelve la misma forma que `procesarMensaje()` para que el anuncio de subida y los roles por nivel funcionen igual que por mensajes. Los logros por XP/nivel que se cumplan se cobran en el próximo mensaje.
- **Escritura con debounce de 5 s**: `procesarMensaje()` deja todo en memoria y agenda el guardado; nunca escribe a disco por mensaje. `volcar()` fuerza el guardado (lo llama el apagado).

## Persistencia local (los almacenes)

`store`, `warns`, `notas`, `casos`, `niveles`, `afk` e `interacciones` comparten mecánica:

- JSON en disco con **escritura atómica** (`archivo.tmp` + `rename`): un corte de luz no corrompe el archivo.
- Caché en memoria; el disco es la copia de respaldo.
- **`marcasPorGuild()`**: timestamp del último cambio **por servidor**, actualizado en cada mutación real. Es lo que compara la restauración con la nube (reemplaza al viejo mtime compartido del archivo).
- Directorio configurable con `TRIGGER_DATA_DIR` (lo usan los tests para correr aislados).

## Respaldo en la base (`db/sync.js` + `db/mariadb.js`)

- El bot comparte la base MariaDB de la web (trigger-arena-db) pero usa **sus propias tablas con prefijo `bot_`** (`bot_data`, `bot_stats`, `bot_cmd`), que crea solo con `CREATE TABLE IF NOT EXISTS` al primer uso. Nunca consulta ni escribe tablas de la web; las consultas van **parametrizadas** (placeholders `?`) y la tabla/columna se valida contra una whitelist.
- `mariadb.js` usa `mysql2/promise` con un pool de 5 conexiones, reintentos del driver y detección de errores de permisos (GRANT).
- Cada guardado local agenda la subida del almacén afectado con **debounce de 3 s** (`marcarSucio`): una ráfaga de mensajes = una subida.
- **Restauración guild-por-guild**: para cada fila de la base compara `version` (timestamp de la subida) contra la marca local de _ese_ servidor. Base más nueva → restaura y actualiza la marca interna; local igual o más nuevo → se sube. Un servidor ya no pisa los datos restaurados de otro y un host nuevo puede descargar todo.
- `subirYa()` para avisos importantes (bot expulsado del server) y `guildDelete.js` agenda la limpieza de sus datos en ambos lados con 60 s de gracia (por si fue un reinicio con re-invitación). Los almacenes respaldados son `config`, `warns`, `notas`, `casos`, `niveles`, `afk` e `interacciones` (los dos últimos se suman a `restaurar()`, `volcarTodo()`, `limpieza.js` y la lista de `guildDelete.js`).
- El puente web (`db/puente.js`) usa la tabla `bot_cmd` como bus de comandos: la web inserta, el bot procesa cada 5 s y marca `procesado_en` + `resultado`. El estado completo (bot + servers + estadísticas) se publica cada 5 s en `bot_data` (clave `bot_estado:_global`) y `set_config` permite editar TODA la config desde la web con validación por esquema. Guía del lado web con snippets PHP: [INTEGRACION-WEB.md](INTEGRACION-WEB.md).
- **Un efecto se ejecuta una sola vez.** Antes de aplicar la acción el bot escribe `resultado = { estado: 'en_ejecucion' }` (sin sellar `procesado_en`, opción `marcarProcesado:false` de `mariadb.actualizar`). Si el UPDATE final que marca `procesado_en` falla, el comando se recuerda en memoria (`ejecutados`) y el tick siguiente reintenta **solo el marcado**, nunca la acción (antes repetía un anuncio o un ban). Si el bot se reinicia con una fila en `en_ejecucion`, no se re-ejecuta: se cierra como `estado: 'indeterminado'` para que la web muestre que el efecto pudo haber ocurrido. Detalle en [INTEGRACION-WEB.md](INTEGRACION-WEB.md).

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

- **Catálogo de proveedores (`PROVEEDORES`)**: la cadena no está hardcodeada. Cada proveedor compatible con la API de OpenAI (chat/completions + models) es una entrada de la tabla —base, variable de clave, variable de modelo, modelos preferidos, filtros y cabeceras propias— y el código es uno solo para todos. Entran en el orden de `ORDEN_PROVEEDORES` (Groq → Cerebras → Gemini → OpenRouter → Mistral) y **solo si tienen clave**: sin `CEREBRAS_API_KEY`, por ejemplo, el bot ni lo intenta ni lo muestra en `/status`. Gemini va aparte porque su API no es compatible (contents/parts en vez de messages). Agregar un proveedor es una entrada más, no código nuevo.
- Los modelos del plan gratuito de Groq viven en la tabla (`candidatosDe`): **no** la familia llama, que pasó a Enterprise en agosto de 2026 y devolvía 404 en cada mensaje. Cada proveedor tiene sus propios filtros: en OpenRouter solo se aceptan modelos `:free` (sin ese filtro la clave gastaría en modelos de pago) y en Mistral se excluyen embeddings, moderación, OCR y visión. Cuando el listado de modelos no está disponible se ordenan por tamaño declarado en el nombre y por los preferidos de la tabla.
- **Carrera con respaldo (hedging):** el proveedor preferido arranca de inmediato y, si no contestó en `HEDGE_MS` (1,4 s), el respaldo se lanza en paralelo; gana el primero que responda bien y el otro resultado se descarta. Va rápido cuando el principal va rápido y no espera la cadena completa cuando está lento.
- **Memoria de fallos en tres niveles**, por proveedor y por modelo: (1) modelo caído por 6 h (404/400 → no vuelve a intentarse), (2) proveedor en pausa según el error (401/403 → 1 h, 429 → 1 min, sin modelos → 30 min) y (3) listado de modelos fallido → no se reintenta por 10 min. Sin esto, un modelo retirado o una clave sin permiso costaban un viaje de red fallido **por mensaje**.
- **Prueba real al arrancar** (`verificarModelos()` desde `precalentar()`): se manda una petición mínima al modelo elegido antes del primer mensaje del usuario, así el descubrimiento de un modelo caído no lo paga quien escribe.
- **Métricas por proveedor**: latencia de cada respuesta (mediana y p95 sobre las últimas 50) y errores acumulados. Se ven en `/status` y viajan en el estado del puente web (`ia.salud`).
- **Perfiles de respuesta**: el mensaje se clasifica en `charla` (temperatura 0,75, 220 tokens, modelo chico de Groq cuando es social) o `consulta` (temperatura 0,3, 700 tokens, modelo grande). Es la palanca que evita que invente datos cuando le preguntan algo concreto.
- **Dos bloques de datos reales en el prompt**: el _contexto en vivo_ (`utils/contexto.js`: servidor y miembros, ficha del autor —nivel, XP, puesto, racha, logros, warns, si está silenciado, si es staff o el dueño—, estado de los servidores CS desde la cache del monitoreo, config relevante y el catálogo de comandos generado desde `client.commands`) y el _conocimiento recuperado_ (`utils/conocimiento.js`: las 3 secciones más parecidas de `docs/conocimiento/*.md`).
- **Anti-alucinación (solo para la comunidad)**: las reglas de precisión separan **dos dominios**. (1) _Datos de la comunidad_ (reglas, sanciones, niveles, comandos, servidores CS, tickets): solo se afirman si están en el contexto en vivo o en la base de conocimiento; si no están, el bot lo dice y deriva al staff. (2) _Conocimiento general_ (deportes, historia, ciencia, famosos, efemérides): el modelo responde con lo que sabe y, si hay RESULTADOS DE BÚSQUEDA WEB, esos mandan. Antes había una sola regla que se aplicaba a todo, y por eso cualquier pregunta de cultura general terminaba en "eso no lo tengo cargado". El catálogo de comandos ya no está hardcodeado: sale de los comandos cargados, así nunca se desincroniza.
- **Respuestas largas**: si el proveedor corta por límite de tokens (`finish_reason: length` / `MAX_TOKENS`) se reintenta una vez con más margen; al enviar, `trocearMensaje()` parte el texto en pedazos de 2000 respetando párrafos y frases (antes un `slice(0, 2000)` perdía el final).
- Memoria por usuario: últimos 6 turnos, TTL de 10 minutos, limpieza periódica del Map. La clave es `userId` (bot de un solo server; si se usara en varios, habría que particionar por `guildId:userId`).
- **Qué se envía al proveedor**: el mensaje del usuario, nombre mostrado del autor, canal, el bloque de datos en vivo (incluye su nivel/XP/puesto y el estado público de los servidores CS) y el historial reciente (hasta 6 turnos de ese usuario). No se envían IDs de Discord, ni contenido de otros usuarios, ni mensajes de canales donde no lo mencionan.
- **Cita de fuentes**: cuando la respuesta salió de una búsqueda web, `conFuentes()` agrega `🔎 Fuentes: [Wikipedia](url) · …` al final (máximo 3, sin repetir URL). Si el modelo ya nombró el link, no se duplica. Un dato sin fuente no es verificable.
- **Caché de respuestas** (`cacheRespuestas`): solo para preguntas **de cultura general** (las de la comunidad dependen de datos vivos y las de charla se sentirían repetidas), por servidor + usuario (la respuesta viaja con la ficha de quien pregunta, así que nunca se le sirve a otro), TTL de 10 min y tope de 200 entradas. Un acierto no consume presupuesto ni latencia.
- **Presupuesto diario** (`utils/presupuesto.js`): tope de respuestas de IA por servidor y por día (día de Argentina, no UTC), configurable con `IA_LIMITE_DIARIO` (300 por defecto). Al agotarse, `conversar()` corta antes de buscar y de generar: el bot contesta con su repertorio local y la vigilancia avisa al staff una vez por jornada. El contador vive en memoria y se respalda en `bot_stats` (volcado diferido de 15 s) y se restaura al arrancar (`precalentar()`), así un reinicio no regala cupo: el bot se reinicia en cada deploy.
- **Cómo limitarlo**: no configurar ninguna clave de IA desactiva el chat externo (queda el repertorio local). El staff puede apagar la IA por servidor con `/config → Chat con IA`.

## Búsqueda web (`utils/web.js`)

- Existe porque las reglas de precisión ("solo afirmá lo que esté en el bloque del servidor") se aplicaban también a la cultura general: la pregunta del caso real —_"@Trigger messi cuántos años tiene"_— terminaba en "eso no lo tengo cargado, abrí un ticket".
- **Fuentes sin claves de API**, en paralelo y con timeout de 3,5 s cada una: Wikipedia en español (API oficial, `generator=search` + `prop=extracts|info` → intro de la entidad más parecida), DuckDuckGo Instant Answer (API oficial) y el HTML público de DDG Lite (best effort: DDG contesta 202 a los clientes automatizados, así que se ignora si no trae resultados).
- **Fuentes especializadas** (`fuentesDe`): cotización del dólar y el euro (Bluelytics) y clima con geocodificación (Open-Meteo). Se suman a la ronda solo cuando la pregunta es de ese tema (`RE_DOLAR`+`RE_VALOR`, `RE_CLIMA`) y van primero porque son el dato exacto y al día; el clima exige una ciudad clara en el texto, si no no consulta nada (responder el clima de otra ciudad es peor que no responder).
- **Investigación en rondas** (`consultarFuentes`): ronda 1 = la pregunta tal cual; si no trajo nada, ronda 2 = Wikipedia en inglés (temas que solo están bien ahí); si tampoco, ronda 3 = la **consulta simplificada** (`simplificar`: sin signos de pregunta y sin palabras vacías, "¿cuántos años tiene Messi?" → `anos messi`) contra es/en y DuckDuckGo. Cada ronda se paga solo cuando la anterior vino vacía.
- **Eficiencia**: dedupe de consultas en vuelo (`enVuelo`: dos pedidos idénticos simultáneos salen a internet una vez), caché por consulta normalizada (10 min; 1 min si vino vacía), resultados deduplicados por URL/título (`depurar`) y tiempo total acotado por `Promise.race`.
- **Decisión de buscar** (`decidirBusqueda`, pura y testeable): no para charla social (perfil `charla`), no si el texto toca temas de la comunidad (`RE_COMUNIDAD`: reglas, warns, niveles, tickets, IP, mix, torneos, discord…), sí para preguntas de cultura general. `forzar: true` cuando el usuario lo pide explícitamente o cuando el dato es perecedero (`RE_DATO_FRESCO`: hoy, precio, resultado, clima, noticias): en ese caso se busca **antes** de responder.
- **Rescate** (`conversar` en `utils/ia.js`): si la respuesta es un "no lo tengo cargado" corto (`pareceSinInfo`) y había búsqueda disponible, se busca en la web y se hace un **segundo intento** de generación con los resultados en el prompt (`contexto.insistir`), en perfil `consulta`. Una sola vez por mensaje y sin búsqueda previa: una pregunta que la IA ya sabe no cuesta ninguna búsqueda.
- **Costos acotados**: caché por consulta (10 min; 1 min si vino vacía), tope global de 20 búsquedas por minuto, cooldown de 10 s por usuario, timeout total de 6 s con `Promise.race`, y resultados recortados (6 resultados, 600 caracteres cada uno, 1.600 en el bloque del prompt).
- **Sin IA (`messageCreate`)**: si no hay claves o cayeron todos los proveedores, una pregunta general igual se responde con `respuestaSinIA` (primer resultado, citando fuente y URL) en vez de caer al repertorio local, que solo sabe decir que no entendió.
- **Verificación y auditoría**: `verificar()` hace una consulta mínima a Wikipedia y guarda el resultado (60 s de caché) para que `/diag` muestre si el host tiene salida a internet; `estadoVerificacion()` lo lee sin disparar otro pedido. El comando **`/buscar`** (staff, efímero) muestra los resultados crudos con su fuente y la decisión que tomaría el bot con esa consulta (clasificación + si buscaría antes de responder), que es lo que hace auditable todo este sistema.

## Vigilancia (`utils/vigilancia.js`)

- Una sola función, `revisar(client, { ping, web })`, produce la lista de problemas; la usan `/diag` (cuando quiere el staff) y `vigilar()` (avisos automáticos). Comparten el núcleo para que el comando y el aviso nunca digan cosas distintas.
- Chequeos: IA (pausas, modelos descartados, latencia), base de conocimiento, carga de archivos, base de datos, escrituras pendientes, voz, servidores CS, **presupuesto de IA agotado** (id con el día, para avisar una vez por jornada) y —solo cuando `/diag` lo pide— **salida a internet** (`web: false` por defecto: la vigilancia automática no golpea la red en cada ciclo).
- **Los chequeos se esperan** (`await correr(...)`). Antes el helper era síncrono y `revisarBaseDeDatos` (async) devolvía una promesa que se descartaba: los problemas de base **nunca** llegaban ni a `/diag` ni a los avisos. Hay un test que lo cubre.

## Base de conocimiento (`docs/conocimiento/` + `utils/conocimiento.js`)

- Un `.md` por tema, y cada `## Título` es una sección independiente: el buscador puntúa secciones (no archivos completos) y devuelve las 3 mejores, recortadas a 1.200 caracteres cada una.
- Índice invertido con **BM25** y dos claves por palabra (la palabra y su raíz de 4 letras): `banear` encuentra `baneo` y `/ban` y `ban` son la misma palabra. Las coincidencias exactas pesan más que las de raíz, así "publicidad" le gana al "pone" de otra sección.
- **Recarga sola**: los archivos se releen como máximo cada minuto, sin reiniciar el bot. `README.md` y los archivos que empiezan con `_` se ignoran (ahí viven las instrucciones de carga).
- **Qué entra al prompt y qué no** (`conocimientoDe` en `utils/ia.js`): la base se inyecta siempre en preguntas de comunidad, **nunca** en charla social y, en preguntas de cultura general, solo si el mejor fragmento tiene una coincidencia **con contenido en su título** (`enTitulo`). Los interrogativos van aparte (`PALABRAS_BLANDAS`: `como`, `cuantos`, `cuanta`…): pueden aportar al ranking —"Cómo pido ayuda"—, pero una coincidencia solo con esas palabras no alcanza. Sin esto, "cómo se calcula el PBI" o la edad de Messi arrastraban secciones de las reglas del server al prompt.
- El contenido es **solo lo verificado, para los datos de la comunidad**: lo que no está escrito no se responde (el bot dice que no tiene esa info y deriva al staff). Eso **no** aplica a las preguntas de cultura general, que salen del conocimiento del modelo + `utils/web.js`. Las 12 normativas de la comunidad están en `reglas.md`, y la sección _Casos que no están contemplados explícitamente_ deja claro que lo que no figura en las normas lo resuelve el staff: mejor derivar que inventar una regla.

## Tickets (`utils/tickets.js`)

- **Tres tipos** en el catálogo `TIPOS`: `soporte`, `apelacion` y `reporte`. Cada uno aporta su etiqueta, el prefijo del canal (`soporte-001`, `reporte-002`…) y las preguntas de su formulario; el panel, los modales, el embed del ticket y el resumen del cierre salen de ahí, así agregar un tipo es agregar una entrada. `/reportar` abre un reporte directo (cualquier miembro, con opción de link a las pruebas).
- **Estado en la config** (`tickets.activos[canalId]`): número, dueño, tipo, apertura y quién lo reclamó. Sobrevive un reinicio, y el topic del canal (última fuente) sigue sirviendo para tickets abiertos antes de este cambio.
- **Reclamar / Agregar usuario**: el primero que reclama deja el ticket a su nombre (el segundo recibe el aviso de quién lo atiende); agregar usuario da acceso al canal por ID o mención y queda anunciado.
- **Calificación al cerrar**: al dueño le llega un DM con botones 1-5 (el `customId` lleva el guild porque en DM no hay guild). El pendiente vive en `tickets.encuestas[userId]` y las respuestas en `tickets.calificaciones` (últimas 100), con el promedio de las últimas en el aviso al canal de logs. Si el DM no sale, no queda encuesta pendiente.
- **Resumen del cierre** (canal, logs y transcript): tipo, abierto por, atendido por (o "nadie lo reclamó"), cerrado por, duración y cantidad de mensajes.
- Apertura con **bloqueo por usuario**: dos clics casi simultáneos no crean dos canales (el segundo ve el bloqueo activo y no hace nada).
- Transcript .txt hasta 50.000 mensajes (500 páginas). Si un `fetch` falla a mitad o se alcanza el tope, el transcript queda marcado como **INCOMPLETO**.
- **Adjuntos grandes**: si el transcript supera el límite de adjunto de Discord (~8 MiB), `dividirTranscript()` lo parte en varios archivos numerados (`-parte-1`, `-parte-2`…) en vez de que el envío falle.
- **Solo se borra el canal si el transcript íntegro quedó guardado en logs** (y hay canal de logs configurado). Si la lectura fue parcial, si el envío a logs falló o si no hay logs, el canal **se conserva** y se avisa al staff para que reintente: nunca se pierde la conversación por un transcript incompleto.

## Tests (`tests/`)

- Runner **nativo de Node** (`node --test`), cero dependencias. `npm test`.
- Cada archivo setea `TRIGGER_DATA_DIR` a un directorio temporal → corre aislado del `data/` real.
- **Fakes, no mocks de librería**: guilds/miembros/interacciones son objetos literales con las propiedades que el código toca; el pool de mysql2 se reemplaza en el require-cache para simular la base (mapa en memoria).
- Cobertura actual:
  - `moderation.test.js` — jerarquía moderador→objetivo y bot→objetivo (el caso "admin con rol bajo").
  - `proteccion.test.js` — detección de spam, ventana, exención de staff, cooldown; acciones con resultado real; raid con auto-acción selectiva.
  - `niveles.test.js` — XP, cooldown, bonus, racha, logros no repetibles, debounce (procesar mensaje **no** escribe a disco), warns.
  - `auditoria.test.js` — registro persistente de casos, `/casos` (por número/usuario), `/nota` separada de los warns y detalle/autocompletado de `/help`.
  - `comandos.test.js` — mensajería, plomería de acciones y el flujo de confirmación/deshacer de `/ban`, `/kick`, `/mute` y `/clear`; y los extras de staff (notas + últimos casos) en `/userinfo`.
  - `sync.test.js` — decisiones de restauración por guild (nube nueva, local nuevo, guild a guild), bug original del mtime, debounce de subida, integración con almacenes reales.
  - `web.test.js` — cuándo corresponde buscar (charla/comunidad/cultura general), detección del "no lo tengo cargado", parseo de Wikipedia y del HTML de DDG Lite (con redirección `uddg`), respaldo en inglés, investigación en rondas con la consulta simplificada, dedupe de pedidos simultáneos, cotización y clima (con ciudad y sin ella), caché, cooldown y fallos: todo con el fetch inyectado, cero red.

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
6. **Comandos de staff**: no agregar `setDefaultMemberPermissions` (ver [Visibilidad de los comandos](#visibilidad-de-los-comandos-en-discord-permisosjs)). La visibilidad de los roles se resuelve en Integrations, no en el código.
