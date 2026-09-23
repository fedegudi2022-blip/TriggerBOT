# Arquitectura de TriggerBOT

Guía técnica de cómo funciona cada sistema. Para el uso (comandos, configuración, deploy), ver el [README](../README.md).

El bot es JavaScript CommonJS sobre **Node 22** (fijado en `engines` y en `.nvmrc`; la CI corre en la misma versión), con **tres dependencias de runtime**: `discord.js`, `dotenv` y `mysql2` (pool MariaDB). Todo lo demás (logger, tests, lint) corre con herramientas nativas o devDependencies.

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
| `src/utils/contexto.js` | Datos en vivo para el prompt de la IA (ficha del autor, servidores CS, config, catálogo real de comandos) |
| `src/utils/conocimiento.js` | Base de conocimiento de la IA: busca en `docs/conocimiento/*.md` con BM25 (sin dependencias) |
| `src/utils/web.js` | Búsqueda web de la IA sin claves de API (Wikipedia, DuckDuckGo, dólar, clima) con caché y topes |
| `src/utils/presupuesto.js` | Presupuesto diario de IA: tope de respuestas por día, contador persistido en `bot_stats` |
| `src/utils/vigilancia.js` | Chequeos de salud (`revisar`) + avisos automáticos al staff (`vigilar`); alimenta `/diag` |
| `src/utils/tickets.js` | Sistema de tickets con transcript |
| `src/utils/voz.js` | Canales de voz temporales Join-to-Create (hub, controles, auto-borrado) |
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
- El puente web (`db/puente.js`) usa la tabla `bot_cmd` como bus de comandos: la web inserta, el bot procesa cada 5 s y marca `procesado_en` + `resultado`. El estado completo (bot + servers + estadísticas) se publica cada 5 s en `bot_data` (clave `bot_estado:_global`) y `set_config` permite editar TODA la config desde la web con validación por esquema. Guía del lado web con snippets PHP: [INTEGRACION-WEB.md](INTEGRACION-WEB.md).

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
- **Dos bloques de datos reales en el prompt**: el *contexto en vivo* (`utils/contexto.js`: servidor y miembros, ficha del autor —nivel, XP, puesto, racha, logros, warns, si está silenciado, si es staff o el dueño—, estado de los servidores CS desde la cache del monitoreo, config relevante y el catálogo de comandos generado desde `client.commands`) y el *conocimiento recuperado* (`utils/conocimiento.js`: las 3 secciones más parecidas de `docs/conocimiento/*.md`).
- **Anti-alucinación (solo para la comunidad)**: las reglas de precisión separan **dos dominios**. (1) *Datos de la comunidad* (reglas, sanciones, niveles, comandos, servidores CS, tickets): solo se afirman si están en el contexto en vivo o en la base de conocimiento; si no están, el bot lo dice y deriva al staff. (2) *Conocimiento general* (deportes, historia, ciencia, famosos, efemérides): el modelo responde con lo que sabe y, si hay RESULTADOS DE BÚSQUEDA WEB, esos mandan. Antes había una sola regla que se aplicaba a todo, y por eso cualquier pregunta de cultura general terminaba en "eso no lo tengo cargado". El catálogo de comandos ya no está hardcodeado: sale de los comandos cargados, así nunca se desincroniza.
- **Respuestas largas**: si el proveedor corta por límite de tokens (`finish_reason: length` / `MAX_TOKENS`) se reintenta una vez con más margen; al enviar, `trocearMensaje()` parte el texto en pedazos de 2000 respetando párrafos y frases (antes un `slice(0, 2000)` perdía el final).
- Memoria por usuario: últimos 6 turnos, TTL de 10 minutos, limpieza periódica del Map. La clave es `userId` (bot de un solo server; si se usara en varios, habría que particionar por `guildId:userId`).
- **Qué se envía al proveedor**: el mensaje del usuario, nombre mostrado del autor, canal, el bloque de datos en vivo (incluye su nivel/XP/puesto y el estado público de los servidores CS) y el historial reciente (hasta 6 turnos de ese usuario). No se envían IDs de Discord, ni contenido de otros usuarios, ni mensajes de canales donde no lo mencionan.
- **Cita de fuentes**: cuando la respuesta salió de una búsqueda web, `conFuentes()` agrega `🔎 Fuentes: [Wikipedia](url) · …` al final (máximo 3, sin repetir URL). Si el modelo ya nombró el link, no se duplica. Un dato sin fuente no es verificable.
- **Caché de respuestas** (`cacheRespuestas`): solo para preguntas **de cultura general** (las de la comunidad dependen de datos vivos y las de charla se sentirían repetidas), por servidor + usuario (la respuesta viaja con la ficha de quien pregunta, así que nunca se le sirve a otro), TTL de 10 min y tope de 200 entradas. Un acierto no consume presupuesto ni latencia.
- **Presupuesto diario** (`utils/presupuesto.js`): tope de respuestas de IA por servidor y por día (día de Argentina, no UTC), configurable con `IA_LIMITE_DIARIO` (300 por defecto). Al agotarse, `conversar()` corta antes de buscar y de generar: el bot contesta con su repertorio local y la vigilancia avisa al staff una vez por jornada. El contador vive en memoria y se respalda en `bot_stats` (volcado diferido de 15 s) y se restaura al arrancar (`precalentar()`), así un reinicio no regala cupo: el bot se reinicia en cada deploy.
- **Cómo limitarlo**: no configurar ninguna clave de IA desactiva el chat externo (queda el repertorio local). El staff puede apagar la IA por servidor con `/config → Chat con IA`.

## Búsqueda web (`utils/web.js`)

- Existe porque las reglas de precisión ("solo afirmá lo que esté en el bloque del servidor") se aplicaban también a la cultura general: la pregunta del caso real —*"@Trigger messi cuántos años tiene"*— terminaba en "eso no lo tengo cargado, abrí un ticket".
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
- El contenido es **solo lo verificado, para los datos de la comunidad**: lo que no está escrito no se responde (el bot dice que no tiene esa info y deriva al staff). Eso **no** aplica a las preguntas de cultura general, que salen del conocimiento del modelo + `utils/web.js`. Las 12 normativas de la comunidad están en `reglas.md`, y la sección *Casos que no están contemplados explícitamente* deja claro que lo que no figura en las normas lo resuelve el staff: mejor derivar que inventar una regla.

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
