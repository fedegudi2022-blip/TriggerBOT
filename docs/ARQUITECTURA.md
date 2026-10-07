# Arquitectura de TriggerBOT

Guía técnica de cómo funciona cada sistema. Para el uso (comandos, configuración, deploy), ver el [README](../README.md).

El bot es JavaScript CommonJS sobre **Node 22** (fijado en `engines` y en `.nvmrc`; la CI corre en la misma versión), con **tres dependencias de runtime**: `discord.js`, `dotenv` y `mysql2` (pool MariaDB). Todo lo demás (logger, tests, lint) corre con herramientas nativas o devDependencies.

## Mapa de módulos

| Módulo                            | Responsabilidad                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/index.js`                    | Punto de entrada: carga comandos/eventos, sesión con reintentos, apagado controlado                       |
| `src/commandLoader.js`            | **Única** fuente de carga de comandos (la usan el runtime y `deploy-commands.js`)                         |
| `src/store.js`                    | Config por servidor (`data/config.json`) + marcas de cambio por guild                                     |
| `src/warns.js`                    | Historial de advertencias (`data/warns.json`)                                                             |
| `src/notas.js`                    | Notas internas del staff (`data/notas.json`), separadas de los warns                                      |
| `src/casos.js`                    | Registro persistente de casos de moderación (`data/casos.json`), lo consulta `/casos`                     |
| `src/niveles.js`                  | XP, niveles, logros, rangos (`data/niveles.json`) con escritura con debounce                              |
| `src/commands/afk.js`             | Estado AFK (`data/afk.json`)                                                                              |
| `src/utils/interacciones.js`      | Contadores de interacciones (`data/interacciones.json`)                                                   |
| `src/db/mariadb.js`               | Cliente MySQL/MariaDB (pool, sin ORM): subir/descargar/listar/ping + creación de tablas bot_              |
| `src/db/puente.js`                | Bus de comandos web ↔ bot vía la tabla `bot_cmd`                                                          |
| `src/db/sync.js`                  | Respaldo y restauración guild-por-guild con debounce                                                      |
| `src/logger.js`                   | Logger estructurado con sanitización de secretos                                                          |
| `src/utils/moderation.js`         | Validaciones de jerarquía compartidas                                                                     |
| `src/utils/acciones.js`           | Plomería de moderación: diferir, resolver miembro, resultado real, límites                                |
| `src/utils/confirmaciones.js`     | Confirmar/deshacer reutilizable para acciones destructivas                                                |
| `src/utils/guia.js`               | Guía de `/help` armada desde los comandos + detalle por comando                                           |
| `src/utils/proteccion.js`         | Anti-spam y anti-raid automáticos                                                                         |
| `src/utils/accionesIA.js`         | Acciones de moderación pedidas por IA (confirmación con botones)                                          |
| `src/utils/contexto.js`           | Datos en vivo para el prompt de la IA (ficha del autor, servidores CS, config, catálogo real de comandos) |
| `src/utils/conocimiento.js`       | Base de conocimiento de la IA: busca en `docs/conocimiento/*.md` (BM25 + semántica híbrida)              |
| `src/utils/embeddings.js`         | Vectores para la búsqueda por significado (Gemini, caché en `data/embeddings.json`, opcional)             |
| `src/utils/web.js`                | Búsqueda web de la IA sin claves de API (Wikipedia, DuckDuckGo, dólar, clima) con caché y topes           |
| `src/utils/presupuesto.js`        | Presupuesto diario de IA: tope de respuestas por día, contador persistido en `bot_stats`                  |
| `src/utils/calculos.js`           | Respuestas exactas sin IA: cuentas, porcentajes, unidades y fechas (parser propio, sin `eval`)            |
| `src/utils/vigilancia.js`         | Chequeos de salud (`revisar`) + avisos automáticos al staff (`vigilar`); alimenta `/diag`                 |
| `src/utils/tickets.js`            | Sistema de tickets con transcript                                                                         |
| `src/utils/voz.js`                | Canales de voz temporales Join-to-Create (hub, controles, auto-borrado)                                   |
| `src/utils/modlog.js`             | Registro numerado de casos de moderación                                                                  |
| `src/utils/log.js`                | Logs generales de eventos (mensajes borrados/editados, ingresos, etc.)                                    |
| `src/utils/estadisticasServer.js` | Canales de estadísticas (`/stats`): alta, baja, cola de renombres y diagnóstico                           |
| `src/utils/censo.js`              | Foto de miembros (humanos/bots) y conteo de «en línea» con presencias + eventos                           |
| `src/utils/intents.js`            | Intents del gateway, con el interruptor `PRESENCE_INTENT` (probado)                                       |
| `src/utils/replies.js`            | Embeds y formato con el estilo visual del bot                                                             |
| `src/utils/cooldowns.js`          | Cooldown por usuario y por comando, aplicado en el handler de comandos de `index.js`                      |

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
- `/logs buscar` (staff) es la otra mitad: filtra el mismo registro por **acción, usuario, moderador y antigüedad** (`/logs buscar accion:baneo desde:7d`), con el autocompletado alimentado por `casos.acciones()` y páginas de 10. Los filtros viven en `casos.listar()` (un solo lugar para el registro, no uno por comando) y la acción se busca por texto — sin mayúsculas ni tildes— para que `baneo` encuentre también `Baneo temporal (tempban)`. La antigüedad usa el mismo parser que `/tempban` (`30m`/`12h`/`7d`, 1 min a 30 días).

## Notas internas (`notas.js` + `/nota`)

- `/nota agregar|ver|quitar` guarda observaciones del staff **separadas de los warns**: no cuentan para el silencio automático de 3 advertencias, así una observación ("ya se le avisó") nunca sanciona sola.
- `ver` **pagina** (5 por página, campos de ≤1 000 caracteres, igual que `/warnings`): antes hacía `slice(0, 4000)` sobre la descripción del embed, así que con un historial largo las últimas notas eran invisibles sin que nadie se enterara. El número de cada nota sigue siendo su posición original, que es la que pide `/nota quitar`.

## Bienvenida (`/bienvenida test`)

- El embed de bienvenida se arma en `events/guildMemberAdd.js` (`renderWelcome()` + `embedBienvenida()`) y lo **reusa** `/bienvenida test`: probar la bienvenida muestra el mismo embed que se publica, no una copia que se desincroniza. El comando es de staff (`ManageGuild`) y efímero.
- Reporta el estado real de la configuración, que hasta ahora solo quedaba en la consola del bot: canal configurado que ya no existe, falta de permiso de **Enviar mensajes** en ese canal y rol de autorol borrado. Con `enviar:true` publica la prueba de verdad en el canal (con una línea que aclara que es una prueba y `allowedMentions: { parse: [] }` para no pingear a nadie).

## Confirmación de acciones destructivas (`confirmaciones.js`)

- `/ban`, `/softban`, `/kick`, `/mute`, `/clear` y `/lockdown bloquear` **no tocan la API al ejecutarse**: validan jerarquía/permisos y muestran un panel efímero con Confirmar/Cancelar (expira en 60 s). Recién al apretar Confirmar corre la acción. `/mute` crea el rol Silenciado dentro de `ejecutar`, así confirmar es lo único que deja un rol nuevo en el servidor.
- `/lockdown` **devuelve el canal a como estaba**: antes de bloquear guarda en la config del server (`c.lockdowns[canalId]`) qué valor tenía `SendMessages` para @everyone (o que no existía el overwrite), y el desbloqueo lo restaura. Con `SendMessages: null` el permiso se **borraba** en vez de restaurarse: un canal de solo lectura quedaba escribible y uno que permitía escribir explícitamente quedaba como si nadie lo hubiera configurado. El estado vive en la config, así que también funciona si desbloquea otro moderador o si el bot se reinició; un bloqueo viejo sin estado guardado se quita igual y el embed lo avisa (caso `restaurado: 'desconocido'`).
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
- **Qué es público lo declara la guía** (`utils/guia.js`): un comando aparece en `/help user` solo si está en una categoría pública (o declara `publico: true`); todo lo demás es de staff. La regla está invertida respecto de la lista negra de 25 nombres que había antes: olvidarse de declarar un comando nuevo lo deja **oculto**, no expuesto. Sumar un comando público es agregarlo a la categoría que le corresponde, y nada más.
- `tests/guia.test.js` fija esa promesa: ningún comando de staff se filtra, ningún comando público desaparece, ningún comando se lista dos veces (tampoco en las notas), todo comando cuyo código llama a `exigirStaff(` queda fuera de la guía pública, y ningún campo se pasa de los límites de Discord.
- **Batería de contrato** (`tests/comandos-contrato.test.js`): ejecuta todos los comandos contra fakes en tres escenarios (sin permiso, con permiso y sin opciones opcionales) y exige que ninguno tire, que todos contesten y que los de staff avisen en efímero. Los que necesitan infraestructura real están en una lista de excluidos con el motivo a la vista.

## Cooldown de comandos (`utils/cooldowns.js`)

- **Por qué existe:** no había ningún límite por usuario y varios comandos salen a la red (Reddit en `/meme`, Wikipedia y DuckDuckGo en `/buscar`, A2S por UDP en `/servidores`, `/ip` y `/jugadores`). Una ráfaga se comía la cuota de esas fuentes y castigaba a todos los demás.
- **Dónde se aplica:** en el handler de comandos de `index.js`, antes de `execute`. La política vive en un solo lugar, así ningún comando nuevo nace sin límite. El bloqueo contesta en **efímero** y en texto plano: `Esperá N s para volver a usar /comando.`
- **Cómo se configura:** cada comando declara `cooldown: <segundos>` en su módulo. Sin declarar nada vale **2 s**; con `cooldown: 0` el comando no tiene límite. Los que salen a la red declaran más: `/meme`, `/buscar`, `/servidores` y `/jugadores` 5 s; `/ip` y `/top` 3 s.
- **El intento bloqueado no renueva el reloj**, a propósito: si lo hiciera, spamear el comando sería la forma de dejarlo bloqueado para siempre. La ventana corre desde el último uso _permitido_.
- El registro es un `Map` con poda (1 000 entradas): el proceso no crece sin control.
- Los **botones y menús no pasan por acá** (siguen en el handler de componentes), así que paginar `/top` o `/warnings` no tiene cooldown.
- `tests/cooldowns.test.js` fija las reglas, incluido que los comandos de red declaren su valor.

## Visibilidad de los comandos en Discord (`permisos.js`)

- Los comandos de staff **no declaran permisos nativos** (`setDefaultMemberPermissions`) a propósito. La autoridad es la política interna de `permisos.js`: dueño, `ManageGuild`, o los roles admin/mod/helper de `/config`; `exigirStaff()` la aplica dentro de `execute()`.
- El motivo es concreto: si `/config` declarara `ManageGuild`, Discord **ocultaría** el comando a un moderador configurado por rol que no tenga ese permiso nativo, aunque `nivelStaff()` lo aceptaría. Declarar el permiso reintroduce el bug que este diseño evita.
- La regla está fijada por tests: `tests/buscar.test.js` y `tests/vigilancia.test.js` exigen `default_member_permissions == null`, así que agregarlo a un comando de staff hace fallar la batería.
- **Consecuencia visible**: un miembro raso ve los comandos de staff en el selector y recibe el aviso efímero de «solo staff» al usarlos. Ocultarlos **no es algo que el bot pueda hacer**: desde 2022 Discord no permite que las aplicaciones administren los overrides de comandos (la API de permisos devuelve `403`). Solo el dueño del servidor, en **Server Settings → Integrations → TriggerBOT**, puede permitir o denegar cada comando por rol —y ahí sí puede habilitar los roles de staff configurados, aunque no tengan permisos nativos—.

## Niveles (`niveles.js`)

- XP base 15-25 por mensaje con cooldown de 60 s (anti-farm). Bonus acumulables: racha (+1 %/día, tope 35 %), noche (+10 %, 00-06 h Argentina), finde (x2, sáb/dom).
- Nivel = `floor(0.1 * sqrt(xp))` (curva cuadrática); 16 logros con premio de XP que pueden encadenar subidas de nivel.
- **Anuncio en un solo mensaje de texto** (`utils/anunciosNivel.js`, nada de embeds): línea 1 qué pasó con la XP que lo causó y el bonus (x2 finde, racha, noche), línea 2 el total y cuánto falta traducido a mensajes, y solo si aplican las líneas de logros agrupados, rol otorgado y cambio de rango. Antes era un embed por logro más el de nivel: una subida con 3 logros nuevos eran 4 mensajes.
- Los **roles por nivel** (`utils/rolesNivel.js`) se asignan _antes_ de anunciar y `asignarRolesNivel()` devuelve solo los que otorgó de verdad, así el anuncio nombra el rol sin prometer uno que Discord rechazó.
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
- **Perfiles de respuesta**: el mensaje se clasifica en `charla` (temperatura 0,75, 220 tokens, modelo chico de Groq cuando es social), `consulta` (temperatura 0,3, 700 tokens, modelo grande) y `profundo` (temperatura 0,35, 1.400 tokens) cuando el pedido pide desarrollo —`RE_PROFUNDO`: explicar, comparar, traducir, resumir, analizar, código, "por qué"— o el texto pasa los 220 caracteres. En Gemini el `thinking` se desactiva solo en los perfiles cortos: el profundo puede pensar antes de contestar. Es la palanca que evita que invente datos cuando le preguntan algo concreto y que se corte a mitad de una explicación. Un saludo o un agradecimiento se reconoce primero (`esMensajeSimple`, comparado sin tildes ni signos de apertura): "¿cómo estás?" es charla y no gasta el modelo grande por contener la palabra "como".
- **Dos bloques de datos reales en el prompt**: el _contexto en vivo_ (`utils/contexto.js`: servidor y miembros, ficha del autor —nivel, XP, puesto, racha, logros, warns, si está silenciado, si es staff o el dueño—, estado de los servidores CS desde la cache del monitoreo, config relevante y el catálogo de comandos generado desde `client.commands`) y el _conocimiento recuperado_ (`utils/conocimiento.js`: las 3 secciones más parecidas de `docs/conocimiento/*.md`).
- **Anti-alucinación (solo para la comunidad)**: las reglas de precisión separan **dos dominios**. (1) _Datos de la comunidad_ (reglas, sanciones, niveles, comandos, servidores CS, tickets): solo se afirman si están en el contexto en vivo o en la base de conocimiento; si el dato exacto no está, el bot contesta con lo que sí está cargado de ese tema y aclara en una frase que ese detalle no lo tiene (la regla 2 prohíbe explícitamente dejar la pregunta sin responder: una negativa seca nunca es una respuesta). (2) _Conocimiento general_ (deportes, historia, ciencia, famosos, efemérides): el modelo responde con lo que sabe y, si hay RESULTADOS DE BÚSQUEDA WEB, esos mandan. Antes había una sola regla que se aplicaba a todo, y por eso cualquier pregunta de cultura general terminaba en "eso no lo tengo cargado". El catálogo de comandos ya no está hardcodeado: sale de los comandos cargados, así nunca se desincroniza.
- **Respuestas largas**: si el proveedor corta por límite de tokens (`finish_reason: length` / `MAX_TOKENS`) se reintenta una vez con más margen; al enviar, `trocearMensaje()` parte el texto en pedazos de 2000 respetando párrafos y frases (antes un `slice(0, 2000)` perdía el final).
- Memoria por usuario: últimos 6 turnos, TTL de 10 minutos, limpieza periódica del Map. La clave es `userId` (bot de un solo server; si se usara en varios, habría que particionar por `guildId:userId`).
- **Qué se envía al proveedor**: el mensaje del usuario, nombre mostrado del autor, canal, el bloque de datos en vivo (incluye su nivel/XP/puesto y el estado público de los servidores CS) y el historial reciente (hasta 6 turnos de ese usuario). No se envían IDs de Discord, ni contenido de otros usuarios, ni mensajes de canales donde no lo mencionan.
- **Respuestas exactas sin IA** (`utils/calculos.js`): antes de llamar a ningún proveedor, `conversar()` intenta resolver el mensaje como cálculo. Un parser recursivo propio (sin `eval`) cubre cuentas (`18% de 3.800`, `12 * (3 + 4)`, `raíz de 144`), conversión de unidades (largo, masa, volumen, tiempo y °C/°F) y fechas (`¿cuántos días faltan para el 25 de mayo?`, con hora de Argentina y salida `<t:…:D>`). Si no está seguro devuelve `null` y sigue el camino normal: no hay respuestas a medias. Gana exactitud (no se equivoca nunca) y disponibilidad (funciona sin claves, con proveedores caídos y con el presupuesto agotado).
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
- **Comunidad, mundo o charla** (`clasificarConsulta`, pura y testeable): una sola lista de palabras ya no decide. Primero manda la **entidad del mundo** (`esDelMundo`): si la pregunta nombra una plataforma, un juego o una marca (YouTube, Google, Twitch, Minecraft, Elden Ring…) sin hablar de este servidor (`RE_CONTEXTO_SERVER`), es de afuera **aunque el ancla también exista acá** — es el caso "¿cuántos logros tiene Elden Ring?", que caía en el camino del servidor por la palabra "logros". Después mandan las **anclas** de la comunidad (`RE_ANCLA`: reglas, warns, tickets, IP, CS 1.6, mix, torneos…). Las palabras **ambiguas** (`RE_AMBIGUA`: canal, rol, nivel, jugador, voz, mapa…) se resuelven con el resto de la frase: con forma de pregunta o pedido de dato van al mundo; sin eso quedan en la comunidad. Y el buscador de la base aporta su señal: si reconoce el tema en el título de una sección y nada indica que la pregunta sea del mundo, es de la comunidad. Ante la duda gana `comunidad`: es preferible inyectar la base de más que responder una regla del server con lo que la IA "cree saber".
- **Decisión de buscar** (`decidirBusqueda`, pura y testeable): no para charla social (perfil `charla`), no para los datos de la comunidad que la base conoce (ahí manda la base del server), sí para **cualquier** pregunta de cultura general —también en las que no llevan palabra interrogativa (`esPedidoDeDato`: `RE_PEDIDO_DATO` para "capital de australia" y la forma invertida `RE_DATO_AL_FINAL`, donde el sujeto va primero y el dato cierra la frase: "messi edad", "nike precio")— y para las preguntas ancladas a la comunidad **de las que la base no sabe nada** (`hayConocimiento === false`: la web queda de reserva, nunca por delante de la base). `forzar: true` cuando el usuario lo pide explícitamente o cuando el dato es perecedero (`RE_DATO_FRESCO`: hoy, precio, resultado, clima, noticias): en ese caso se busca **antes** de responder.
- **Red de datos reales** (`conversar` en `utils/ia.js`): la búsqueda dejó de ser el último recurso. Cuando es reserva arranca **en paralelo con la generación** (si la IA ya sabe la respuesta, los resultados se descartan sin haber pagado latencia); cuando `forzar`, se espera y los resultados viajan en el prompt como fuente principal. Si la respuesta es una negativa corta (`pareceSinInfo`) y la pregunta es averiguable (`plan.buscar || modo === 'general'`), se reescribe con los datos: (1) los resultados que ya están, (2) los de la búsqueda forzada que se había hecho antes —el caso que se perdía: el bot tenía los datos en la mano y le devolvía la negativa al usuario—, o (3) si la búsqueda no trajo nada y la pregunta es del mundo, una **tercera generación** con la instrucción `contexto.sinDatos` ("está prohibido volver a negarte: respondé con lo que sepas"). Si el modelo vuelve a negarse con datos disponibles, se responde `respuestaDeDatos`: el dato crudo con su fuente. Una sola vuelta extra por mensaje.
- **Costos acotados**: caché por consulta (10 min; 1 min si vino vacía), tope global de 30 búsquedas por minuto, cooldown de 10 s por usuario (que `forzar` saltea), timeout total de 6 s con `Promise.race`, y resultados recortados (6 resultados, 600 caracteres cada uno, 1.600 en el bloque del prompt).
- **Sin IA (`messageCreate`)**: si no hay claves o cayeron todos los proveedores, una pregunta general igual se responde con `respuestaSinIA` (primer resultado, citando fuente y URL) en vez de caer al repertorio local, que solo sabe decir que no entendió.
- **Verificación y auditoría**: `verificar()` hace una consulta mínima a Wikipedia y guarda el resultado (60 s de caché) para que `/diag` muestre si el host tiene salida a internet; `estadoVerificacion()` lo lee sin disparar otro pedido. El comando **`/buscar`** (staff, efímero) muestra los resultados crudos con su fuente y la decisión que tomaría el bot con esa consulta (clasificación + si buscaría antes de responder, en paralelo o nada), que es lo que hace auditable todo este sistema.

## Calidad medida: negativas y latencia (`utils/faltantes.js` + `utils/rendimiento.js`)

- **La lista de lo que falta en la base** (`faltantes.js`): cada vez que la respuesta final de `conversar()` queda en negativa (`pareceSinInfo` sobre el texto ya con fuentes), la pregunta se registra en `data/faltantes.json` agrupada por clave normalizada (sin tildes ni signos: “¿Cuál es el horario?” y “cual es el horario” son el mismo tema). Cada entrada guarda `veces`, `primera`/`ultima`, los nombres de quienes la preguntaron, el canal, el modo (comunidad/general/charla) y el perfil. Es una **cola acotada** (`MAX_TEMAS = 60` por servidor): al llenarse se va el tema menos reciente, así los que más se repiten quedan arriba. Se respalda en MariaDB como el resto de los almacenes (`marcarSucio(guildId, 'faltantes', …)` y `ready.js` lo pasa a `restaurar()`), y **nunca** puede romper la respuesta: el guardado va en try/catch porque es un extra para el staff.
- **Vista del staff** (`/faltantes`): `ver` (cantidad 1-20, los más preguntados primero), `borrar numero` (el puesto de ESA lista, no el orden de inserción) y `limpiar confirmar:true`. El flujo es cargar la sección en `docs/conocimiento/` y borrar el tema; los de cultura general apuntan a la salida a internet del host (`/diag`) en vez de a la base.
- **Latencia por perfil** (`rendimiento.js`): una muestra por turno de `conversar()` con `perfil` (charla/consulta/profundo), `camino` (cálculo/caché/IA/local), `ms` de punta a punta, `generaciones` (2+ = rescate con web), `web` (forzada/paralela/directa/no) y `sinIA` (presupuesto agotado o proveedores caídos). Ventana **en memoria** de 200 muestras desde el arranque: una escritura a disco por mensaje no se justifica para una métrica que se mira a mano.
- Los turnos que se resuelven **sin IA** (presupuesto agotado o todos los proveedores caídos) los mide `events/messageCreate.js` con `medirSinIA()`: ahí el tiempo real incluye la búsqueda web directa del respaldo, y si solo se midiera `conversar()` parecerían instantáneos. Los que se responden con cálculo exacto o caché también dejan muestra: son la prueba de que esos caminos son instantáneos.
- **Vista del staff**: `/status` muestra la mediana por perfil (compacto) y `/latencias` el detalle —cada perfil con el desglose de caminos, cada causa con su mediana, y las 5 más lentas con su pregunta y su causa—. Sin esto era imposible distinguir “el proveedor está lento” de “esta respuesta tardó porque buscó antes de responder y encima rescató con web”.

## Vigilancia (`utils/vigilancia.js`)

- Una sola función, `revisar(client, { ping, web })`, produce la lista de problemas; la usan `/diag` (cuando quiere el staff) y `vigilar()` (avisos automáticos). Comparten el núcleo para que el comando y el aviso nunca digan cosas distintas.
- Chequeos: IA (pausas, modelos descartados, latencia), base de conocimiento (vacía = error; **semántica caída = aviso**, con la acción para revisar la clave de Gemini), carga de archivos, base de datos, escrituras pendientes, voz, servidores CS, **presupuesto de IA agotado** (id con el día, para avisar una vez por jornada) y —solo cuando `/diag` lo pide— **salida a internet** (`web: false` por defecto: la vigilancia automática no golpea la red en cada ciclo).
- **Los chequeos se esperan** (`await correr(...)`). Antes el helper era síncrono y `revisarBaseDeDatos` (async) devolvía una promesa que se descartaba: los problemas de base **nunca** llegaban ni a `/diag` ni a los avisos. Hay un test que lo cubre.

## Base de conocimiento (`docs/conocimiento/` + `utils/conocimiento.js`)

- Un `.md` por tema, y cada `## Título` es una sección independiente: el buscador puntúa secciones (no archivos completos) y devuelve las 3 mejores, recortadas a 1.200 caracteres cada una.
- Índice invertido con **BM25** y dos claves por palabra (la palabra y su raíz de 4 letras): `banear` encuentra `baneo` y `/ban` y `ban` son la misma palabra. Las coincidencias exactas pesan más que las de raíz, así "publicidad" le gana al "pone" de otra sección.
- **Búsqueda híbrida** (`buscarHibrido`, la que usa la charla): BM25 siempre y, cuando las palabras no alcanzan, también **semántica** con `utils/embeddings.js`. La pregunta y las secciones se comparan como vectores (similitud coseno) y las dos señales se normalizan y combinan (0,4 palabras / 0,6 significado) sobre el mismo conjunto de candidatos. Dos umbrales (`KB_SEMANTICO_UMBRAL` para aceptar una sección que BM25 no encontró, `KB_SEMANTICO_TITULO` para contar como «tema cargado») se ajustan por entorno y se calibran con lo que muestra `/buscar`. El camino común —la base reconoció el tema por una palabra del título— **no pide ningún vector**, y cuando los vectores están calculándose, la búsqueda **espera ese mismo trabajo** en vez de degradar la primera pregunta a la búsqueda por palabras.
- **Nunca puede romper una respuesta** (`embeddings.js`): sin clave de Gemini, con `KB_SEMANTICO=off`, sin salida a internet o con un 429/401, `vectorizar` devuelve `null` y el buscador sigue con BM25. Hay memoria de fallos (un 429 castiga un minuto, una clave inválida una hora) para no pagar un viaje de red fallido en cada pregunta, y una respuesta rara del proveedor (400 por `taskType`) se reintenta una vez sin ese campo. Los vectores se cachean en `data/embeddings.json` (base64 de `Float32Array`, escritura atómica por `rename`): es un **dato derivado** —si se borra, se recalcula— así que no va al respaldo de MariaDB, y la clave de la caché es el hash del texto (una sección editada solo se vuelve a vectorizar a sí misma). No consume presupuesto de IA: no es una respuesta, es una consulta de índice.
- **Estado y aviso**: `/diag` informa secciones, archivos y si la semántica está activa (con el modelo y los umbrales vigentes); `/buscar` muestra el origen de cada fragmento (palabras / semántico / ambos) y la similitud; y la vigilancia emite el aviso `conocimiento-semantico` (nivel *aviso*, no error) cuando el proveedor se cayó: la base queda buscando solo por palabras y el bot sigue respondiendo igual.
- **Recarga sola**: los archivos se releen como máximo cada minuto, sin reiniciar el bot. `README.md` y los archivos que empiezan con `_` se ignoran (ahí viven las instrucciones de carga).
- **Qué entra al prompt y qué no** (`conocimientoDe` en `utils/ia.js`): la base se inyecta **solo en preguntas de comunidad** (es la única fuente de verdad de las reglas y los comandos). En `general` no viaja nunca: el modo es general justamente porque la pregunta es de afuera o nombra una entidad del mundo, así que meterle secciones del server solo confundiría al modelo. En `charla` tampoco. Los interrogativos van aparte (`PALABRAS_BLANDAS`: `como`, `cuantos`, `cuanta`…): pueden aportar al ranking —"Cómo pido ayuda"—, pero una coincidencia solo con esas palabras no basta para `enTitulo`, que es la señal de que el tema está cargado de verdad.
- El contenido es **solo lo verificado, para los datos de la comunidad**: lo que no está escrito no se responde (el bot dice que no tiene esa info y deriva al staff). Eso **no** aplica a las preguntas de cultura general, que salen del conocimiento del modelo + `utils/web.js`. Las 12 normativas de la comunidad están en `reglas.md`, y la sección _Casos que no están contemplados explícitamente_ deja claro que lo que no figura en las normas lo resuelve el staff: mejor derivar que inventar una regla.

## Canales de estadísticas (`estadisticasServer.js` + `censo.js` + `/stats`)

- **Qué son**: canales de VOZ de solo lectura (`Connect` denegado para @everyone) cuyo NOMBRE lleva el número en vivo: «👥 Miembros: 87.614». Es el único lugar donde Discord deja poner un contador que se ve sin abrir nada.
- **Catálogo de métricas** (`METRICAS`): `miembros`, `humanos`, `enLinea`, `roles`, `canales`, `boosts`. Cada una es una entrada con su `valor(guild)` (número o `null`); sumar una métrica es sumar una entrada, no código nuevo. `normalizarMetricas` acepta lo que la gente escribe de verdad (`online`, `en linea`, `boost`).
- **Sin dato no se inventa un número**: si una métrica no se pudo medir, el canal muestra `—`. El caso concreto es «en línea» sin Presence Intent (ver abajo) y «humanos» antes de la primera foto del censo.
- **Límite de renombres**: Discord permite **2 renombres por canal cada 10 minutos**, así que el refresco corre cada 10 min y cada canal tiene su cola (`cola.sellos`). Si el cupo está usado, el renombre queda agendado y `aplicarPendiente()` **recalcula el valor del momento** en vez de aplicar el número viejo. Un rechazo de Discord no se reintenta en bucle: se reporta (`/stats refrescar`, `/stats estado`, vigilancia) y se espera la próxima pasada.
- **Config por servidor** (`c.stats` en `store.js` → viaja con el respaldo de MariaDB): `activado`, `categoriaId`, `metricas` y `canales` (métrica → canal). `/stats activar` y `/stats metricas` comparten `aplicarMetricas()`, que es la única implementación de «qué canales tiene que haber»: crea los que faltan, borra los de las métricas que salieron y guarda. Re-activar no duplica canales.
- **Censo de miembros** (`censo.js`): `members.fetch({ withPresences: true })` una vez al arrancar y cada 6 h por servidor **con los canales activados** (no se descarga la lista entera de un servidor que no va a mostrar el dato), y desde ahí `events/presenceUpdate.js` mantiene el Set de conectados. `guildMemberRemove` saca al que se fue. Sin foto, los cambios de presencia **no** cuentan: arrancar a sumar sobre la nada daría un total inventado.
- **Presence Intent**: `utils/intents.js` decide la lista de intents y `PRESENCE_INTENT=false` es la salida de emergencia (pedir un intent privilegiado sin habilitarlo en el portal cierra la conexión con `4014` y el bot no arranca; `index.js` detecta ese error y dice exactamente qué hacer). El reintento de login cada 60 s hace que prender el interruptor en el portal alcance sin tocar nada más.
- **Diagnóstico en una sola fuente**: `diagnosticoStats(guild)` produce los problemas (canal borrado, renombres rechazados, «en línea» sin presencias) y los consumen `/stats estado` y la vigilancia (`revisarStats`), que los publica en el canal de avisos: nadie tiene que acordarse de mirar los canales.

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
  - `auditoria.test.js` — registro persistente de casos, `/casos` (por número/usuario), `/nota` separada de los warns (con la paginación de `ver`), `/logs buscar` (filtros y paginado) y detalle/autocompletado de `/help`.
  - `comandos.test.js` — mensajería, plomería de acciones y el flujo de confirmación/deshacer de `/ban`, `/kick`, `/mute` y `/clear`; el ida y vuelta de `/lockdown` (bloquear → desbloquear devuelve el permiso previo) y los extras de staff (notas + últimos casos) en `/userinfo`.
  - `bienvenida.test.js` — el render compartido con `guildMemberAdd` y `/bienvenida test`: previsualización, avisos de configuración rota y el envío real sin mencionar a nadie.
  - `logs.test.js` — filtros de `casos.listar()` (usuario, moderador, acción por texto, fechas) y el comando `/logs buscar` con fakes.
  - `serverinfo.test.js` — conteo de humanos/bots cuando la descarga de miembros falla (no inventa el número) y cuando funciona.
  - `stats.test.js` — canales de estadísticas: nombres con el número o «—», canales de solo lectura, alta/baja/cambio de métricas sin duplicar, refresco que respeta los 2 renombres por canal y reporta «perdido» o «rechazado», y el diagnóstico.
  - `censo.test.js` — foto de miembros con y sin Presence Intent (nunca un 0 inventado), conteo al conectarse/desconectarse, y el `fetch` que falla sin dejar una foto a medias.
  - `intents.test.js` — el Presence Intent se pide por defecto y `PRESENCE_INTENT=false` es la salida de emergencia sin tocar el resto.
  - `sync.test.js` — decisiones de restauración por guild (nube nueva, local nuevo, guild a guild), bug original del mtime, debounce de subida, integración con almacenes reales.
  - `web.test.js` — cuándo corresponde buscar (charla/comunidad/cultura general), las entidades del mundo que usan palabras del servidor ("logros" de un juego), detección del "no lo tengo cargado" (incluidas las negativas amables), parseo de Wikipedia y del HTML de DDG Lite (con redirección `uddg`), respaldo en inglés, investigación en rondas con la consulta simplificada, dedupe de pedidos simultáneos, cotización y clima (con ciudad y sin ella), caché, cooldown y fallos: todo con el fetch inyectado, cero red.
  - `conocimiento.test.js` — armado de secciones (H1, archivos ignorados), búsqueda por palabras con raíces, umbral relativo, recorte de secciones gigantes, contenido real distribuido (incluido que una pregunta general **no** dé coincidencia en el título) y la **búsqueda híbrida** con vectores falsos: encuentra por significado sin ninguna palabra en común, el camino rápido de BM25 no pide vectores, el acierto parcial respeta el umbral configurable, y con el proveedor caído sigue respondiendo por palabras con el estado reportado.
  - `embeddings.test.js` — sin clave (o con `KB_SEMANTICO=off`) no se llama a nadie y `vectorizar` devuelve `null`; lotes de 50, `taskType` de documento/consulta, caché en disco que sobrevive un reinicio, salto al modelo siguiente ante un 404 (y no cuando el modelo está forzado), reintento sin `taskType` recordado, castigos de 429/401/red, y la similitud coseno (vectores iguales, perpendiculares e inválidos): todo con el proveedor inyectado, cero red.

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
