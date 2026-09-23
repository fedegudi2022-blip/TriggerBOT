# TriggerBOT

Bot de Discord privado para la comunidad **Trigger**, hecho en Node.js con discord.js v14. La configuración y el historial de warns se guardan en archivos JSON simples, con respaldo en la base de datos MariaDB de la web (tablas propias `bot_`).

## Estructura

```
src/
├── index.js            # Punto de entrada: carga comandos/eventos, sesión con reintentos y apagado controlado
├── commandLoader.js    # Carga ÚNICA de comandos (la usan el runtime y deploy-commands)
├── deploy-commands.js  # Registra los comandos slash en Discord (npm run register)
├── logger.js           # Logger estructurado con sanitización de secretos
├── store.js            # Config por servidor en data/config.json
├── warns.js            # Historial de warns en data/warns.json
├── niveles.js          # XP, niveles y logros en data/niveles.json (escritura con debounce)
├── db/
│   ├── mariadb.js      # Cliente MySQL/MariaDB (pool + tablas bot_ autogestionadas)
│   ├── puente.js       # Bus de comandos web ↔ bot vía tabla bot_cmd
│   └── sync.js         # Respaldo/restauración guild-por-guild con debounce
├── commands/           # Un archivo por comando slash
├── events/             # Un archivo por evento (ready, logs, ...)
└── utils/
    ├── moderation.js   # Validaciones de jerarquía compartidas (comandos + IA + protección)
    ├── proteccion.js   # Anti-spam y anti-raid automáticos
    ├── accionesIA.js   # Acciones de moderación pedidas por IA (confirmación del staff)
    ├── contexto.js     # Datos en vivo para el prompt de la IA (nivel, servidores CS, comandos)
    ├── conocimiento.js # Buscador (BM25) de la base de conocimiento en docs/conocimiento
    ├── tickets.js      # Sistema de tickets con transcript
    ├── modlog.js       # Registro de acciones de moderación (mod-log)
    ├── log.js          # Registro de eventos generales (logs)
    └── replies.js      # Embeds con el estilo visual unificado del bot
tests/                  # Tests con el runner nativo de Node (npm test)
docs/ARQUITECTURA.md    # Documentación técnica de cada sistema
```

> `data/` se crea solo y está en `.gitignore`: cada entorno (local/Wispbyte) tiene su propia configuración.

## Desarrollo

```bash
npm test        # tests (runner nativo de Node, sin dependencias)
npm run lint    # ESLint: errores reales, no estilo
npm run format  # Prettier
npm run check   # lint + tests: el mínimo antes de subir cambios
```

Los tests corren aislados del `data/` real (usan un directorio temporal) y no tocan la red. Cómo funciona cada sistema por dentro: [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Comandos

### General
| Comando | Qué hace | Quién lo usa |
|---|---|---|
| `/ping` | Latencia del bot con indicador de calidad y botón de refresco | Todos |
| `/status` | Estado del bot: modelos de IA, latencia, tiempo encendido, uso — con botón de refresco | Todos |
| `/redes` | Redes oficiales de la comunidad (WhatsApp, Steam, Instagram) con botones de link directo | Todos |
| `/web` | Link del sitio oficial [triggerarena.pro](https://triggerarena.pro/) con botón directo | Todos |
| `/voz activar/hub/categoria/formato/contador/logs/estado` | Staff: activa los **canales de voz temporales** (ver abajo) | Staff (config) |
| `/servidores` | Estado en vivo de los servers CS 1.6 (jugadores, mapa, IP). Staff: `publicar:true` fija un panel que se actualiza solo | Todos |
| `/ip [servidor]` | IP para conectarte, lista para copiar. Con filtro por nombre muestra mapa y jugadores de ahora | Todos |
| `/ticket publicar/categoria/logs/mensaje` | Panel de soporte con botón, canales privados por ticket y transcript al cerrar | Staff (config) |
| `/help user` | Guía de comandos para usuarios, por categorías | Todos |
| `/help staff` | Guía completa (incluye moderación y configuración); respuesta de staff, no visible en canales públicos | Staff |
| `/userinfo [usuario]` | Ficha de usuario: fechas, roles, permisos, warns | Todos |
| `/serverinfo` | Ficha del server: dueño, canales, roles, boosts | Todos |
| `/avatar [usuario]` | Avatar en grande con link de descarga | Todos |
| Mencionar al bot (`@TriggerBOT`) | Charla con IA, con indicador de escribiendo y contexto | Todos |
| `@TriggerBOT muteá a @fulano por spam` | La IA interpreta el pedido y el staff lo confirma con botones | Todos (confirma staff) |
| `@TriggerBOT ping` | Ping rápido por mención | Todos |

### Moderación
| Comando | Qué hace | Permisos |
|---|---|---|
| `/warn usuario [razon]` | Advierte a un usuario. **Al 3er warn: timeout de 1 h automático** | Mods |
| `/warnings usuario` | Muestra el historial de advertencias | Mods |
| `/quitarnota usuario numero [razon]` | Elimina una advertencia del historial | Mods |
| `/kick usuario [razon]` | Expulsa a un usuario | Mods |
| `/ban usuario [razon] [borrar_dias]` | Banea y opcionalmente borra mensajes | Mods |
| `/unban usuario_id [razon]` | Revoca un baneo por ID | Mods |
| `/softban usuario [borrar_dias] [razon]` | Expulsa borrando sus mensajes (ban + unban) | Mods |
| `/timeout usuario duracion [razon]` | Silencia de 5 min a 28 días | Mods |
| `/mute usuario [razon]` | Silencia con rol (crea el rol *Silenciado* solo) | Mods |
| `/unmute usuario [razon]` | Quita el silencio | Mods |
| `/clear cantidad [usuario] [razon]` | Borra hasta 100 mensajes recientes | Mods |
| `/lockdown bloquear/desbloquear [canal]` | Cierra o reabre un canal | Mods |
| `/slowmode segundos [canal]` | Modo lento de 0 s a 6 h | Mods |

> Todos los comandos de moderación validan jerarquía (no podés moderar a alguien con rol igual o superior), avisan al usuario por DM cuando es posible y quedan registrados en el mod-log.

### Tickets de soporte

Se arma en 3 pasos: `/ticket logs` (dónde quedan los transcripts) → `/ticket categoria` (dónde se crean los canales) → `/ticket publicar` en tu canal de soporte.

- **Panel con botón**: cada usuario abre su ticket con un clic; se crea un canal privado `ticket-001` visible solo por él y el staff (roles admin/mod/helper de `/config`). Un ticket abierto por persona.
- **Al abrir**: el usuario cuenta el motivo en una ventana emergente y queda registrado con su cuenta.
- **Al cerrar** (botón 🔒, disponible para el dueño o el staff): el bot genera un **transcript .txt** con toda la conversación, lo manda al canal de logs, se lo deja por **DM al usuario** y borra el canal 30 segundos después. Todo queda registrado.
- **Personalizable**: `/ticket mensaje` cambia el texto del panel. También se configura desde `/config → Tickets de soporte`.

### Protección automática (anti-spam y anti-raid)

Se activa desde `/config → Anti-spam y anti-raid` (apagada por defecto):

- **Anti-spam**: si alguien supera el umbral (por defecto 5 mensajes en 5 s), borra la ráfaga, aplica la acción elegida (borrar / timeout 10 min / silenciar / expulsar / banear) y avisa al canal de staff. El staff con permiso de gestionar mensajes está exento, y cada usuario tiene 30 s de gracia entre castigos.
- **Anti-raid**: si entran más de X cuentas en Y segundos (por defecto 8 en 60 s), alerta al staff con la lista de ingresos (marcando cuentas de menos de 7 días 🆕). Opcionalmente puede **actuar sola** (expulsar o banear) sobre cuentas nuevas sin roles.

Todo queda registrado en el mod-log como acción del bot.

### Canales de voz temporales (estilo VoiceMaster)

Se activa con **`/voz activar`**: el bot crea un canal de voz **«➕ Crear canal»**. Cuando alguien entra ahí, recibe **su propio canal temporal** —por defecto **«🔊 Canal de Voz de {usuario}»** (formato configurable con `/voz formato`)— y un panel de controles:

> 📍 **Categoría destino:** el staff elige dónde se crean los canales temporales con **`/voz categoria`**. Si se cambia, los canales ya creados **se mueven solos** a la nueva categoría (conservando permisos). Si nunca se configuró, se crean en la misma categoría que el hub.
>
> 📋 **Registro:** por defecto solo se registran los **fallos** (no se pudo crear un canal) para no llenar el canal de logs de spam. Con **`/voz logs todo`** el staff activa el registro de cada creación, transferencia y borrado; con `nada` se silencia todo el registro de voz. Los eventos van al canal de logs de `/config` (o mod-log si no hay logs configurado).

- **📝 Renombrar** y **👥 límite de usuarios** (0-99) con ventanas emergentes.
- **🔒 Cerrar / 🔓 abrir** el canal (bloquea la entrada de gente nueva).
- **👢 Expulsar** a alguien del canal y **👑 transferir** la propiedad.
- **✋ Reclamar**: si el dueño se fue, cualquiera adentro puede tomar el canal.
- **🗑️ Borrar** el canal cuando quieras.

**Automático:** si el dueño se va pero queda gente, la propiedad pasa al primer humano que quedó; si el canal queda vacío, **se borra solo** (con 2 s de gracia por si el dueño vuelve). Un usuario tiene un solo canal a la vez (si vuelve a entrar al hub, va al suyo). Los canales activos sobreviven reinicios (quedan en la config respaldada en MariaDB) y al arrancar se limpian los que quedaron vacíos. Tope de 25 canales temporales por server (anti-flood).

🔢 **Contador en el nombre:** cada canal muestra cuántos hay adentro —«· 3», o «· 3/5» con límite— y se actualiza solo al entrar o salir gente (se apaga con `/voz contador`). Discord limita los renombres a **2 por canal cada 10 minutos**: el bot junta los cambios y aplica el valor más nuevo apenas se libera el cupo, así que el número puede demorarse un poco en actualizarse.

### Servidores CS 1.6 (monitoreo y panel en vivo)

Se configura desde `/config → Servidores CS 1.6`: cargás cada server con nombre e `IP:puerto` (por ejemplo `cs.nostalgia.ar:27015`). Con eso:

- **`/servidores`** consulta cada server por el protocolo de Valve (A2S, UDP directo, sin depender de la web) y muestra estado, jugadores, mapa, latencia y ocupación. El staff puede publicar un **panel auto-actualizado** (`/servidores → publicar`) que el bot edita solo cada 90 s.
- **`/ip`** responde la IP en bloque de código para copiar; con filtro por nombre muestra el mapa y los jugadores de ahora.
- **Alertas**: si un server deja de responder o vuelve, avisa al canal de staff (canal de avisos, logs o mod-log). Se pueden apagar desde el panel.

El monitoreo hace 2 intentos con timeout de 2,5 s antes de dar un server por caído (UDP pierde paquetes), y los comandos consultan en paralelo con la caché del monitoreo para responder al instante.

### Niveles y logros
| Comando | Qué hace |
|---|---|
| `/estadisticas [usuario]` | Perfil completo: rango, nivel, XP con barra, bonus activos, racha, puesto y logros con premios |
| `/logros [usuario]` | Progreso logro por logro: barra, cuánto falta para cada uno y XP pendiente de cobro |
| `/rolnivel definir/quitar/lista` | Staff: roles que se otorgan automáticamente al alcanzar un nivel |
| `/top [pagina]` | Ranking con podio y navegación por botones ◀️ ▶️ |

XP por escribir (15-25 por mensaje, máximo 1 por minuto para evitar farmeo) con **bonus acumulables**: +1% por día de racha (tope +35%), **x2 los fines de semana** y +10% de madrugada (00-06 h Argentina). **16 logros desbloqueables con recompensa de XP** (se pagan solos al cumplirlos), rangos por nivel (Novato → Activo → Experto → Veterano → Leyenda) y **roles por nivel**: el staff define con `/rolnivel` qué rol se otorga automáticamente al alcanzar cada nivel. El staff configura el canal de anuncios en el panel `/config → Niveles y XP`.

### Utilidades
| Comando | Qué hace |
|---|---|
| `/afk [motivo]` | Te marca ausente; al mencionarte, el bot avisa. Se saca solo al volver a hablar |
| `/encuesta tema [opciones]` | Encuesta con reacciones (Sí/No o hasta 6 opciones propias) |
| `/embed titulo texto [color] [imagen] [canal]` | Anuncios profesionales con embeds (staff) |
| `/plantillas agregar/quitar/lista` | Razones rápidas que autocompletan `/warn`, `/ban`, `/kick`, etc. (staff) |
| `/frases configurar/agregar/publicar/lista/quitar` | Frase del día publicada automáticamente a la hora elegida (staff) |

### Diversión y comunidad
| Comando | Qué hace |
|---|---|
| `/beso` `/abrazo` `/caricia` `/abofetear` `/morder` `/pellizco` `/chocar` `/guino` | Interacciones con GIF animado y contadores persistentes (uno por comando, con @usuario) |
| `/meme` | Meme al azar de Reddit (r/memes, r/memesesp y más) con botón Otro |
| `/8ball pregunta` | La bola 8 mágica responde con 20 veredictos |
| `/dado [caras]` | Tira un dado (1-6 o hasta 100 caras) |
| `/moneda` | Cara o ceca |

### Configuración (solo staff)

`/config` abre un **panel interactivo**: un menú desplegable con las secciones (Bienvenida, Mod-log, Logs, Avisos, Staff, Rol de silenciado, Chat con IA, Niveles, Frase del día, Anti-spam y anti-raid, Tickets de soporte, Desactivar) y, dentro de cada una, selectores nativos para elegir canales y roles con un clic — sin tipear IDs ni opciones. El mensaje de bienvenida se edita en una ventana emergente y cada desactivado pide confirmación. Todo se guarda al instante y el panel es visible solo para quien lo abre.

## Chat con IA (opcional)

El bot puede conversar cuando lo mencionás, con memoria de contexto por usuario (los últimos 6 turnos, se olvida a los 10 minutos). Responde **con datos reales del servidor**, no de memoria: antes de cada respuesta el prompt se arma con

- tu ficha (`nivel`, XP, puesto en el ranking, racha, logros y advertencias) y si estás silenciado,
- el estado en vivo de los servidores CS 1.6 (jugadores, mapa, caído) y lo que esté activo (tickets, voz, anti-spam),
- el **catálogo real de comandos** (sale de los comandos cargados: nunca se desincroniza), y
- los fragmentos más parecidos de la **base de conocimiento** (`docs/conocimiento/*.md`).

Si la respuesta no está en esos datos, el bot **lo dice y te deriva al staff** en vez de inventar. Para enseñarle algo nuevo (reglas, FAQ, horarios), editá o agregá un `.md` en `docs/conocimiento/` siguiendo el [README de esa carpeta](docs/conocimiento/README.md): se recarga solo en menos de un minuto, sin reiniciar. Las 12 normativas de la comunidad ya están cargadas en `docs/conocimiento/reglas.md`: si el staff las cambia, se edita ese archivo (o se agrega uno nuevo) y el bot responde la versión actualizada.

**Acciones de moderación por chat:** si un usuario le pide `@TriggerBOT banear a @fulano por flodeo`, la IA interpreta el pedido y muestra un embed con botones. **Solo el staff** (permisos de moderación o roles de `/config staff`) puede apretar **Ejecutar**; la acción queda registrada en el mod-log. Hay cooldown de 20 s por usuario para evitar abusos y las solicitudes expiran a los 5 minutos.

**Cadena de respaldo automática (optimizada por velocidad):**
1. **Groq** (principal) — chips LPU: responde en ~0,3-0,8 s, 5-10x más rápido que Gemini.
2. **Gemini** (respaldo de calidad) — si Groq no tiene clave, falla o se queda sin cuota; se autorrepara si Google retira un modelo.
3. **Respuestas locales** — si no hay claves o todo falla, usa su repertorio propio. Nunca se queda mudo.

**Optimizado para responder rápido:**
- **Respuestas instantáneas (0 ms):** preguntas canónicas (quién te creó, cuál es la web, las redes, saludos de identidad) se responden sin llamar a la IA — funcionan siempre, incluso sin claves o con los proveedores caídos.
- **Enrutado por complejidad:** los mensajes sociales cortos ("hola", "todo bien?", "gracias", "jaja") van al modelo chico `llama-3.1-8b-instant` (~2-3x más rápido) y el `70b` queda para preguntas que sí requieren pensar.
- **Dos perfiles:** *charla* (temperatura 0,75, respuestas de 1-3 frases) y *consulta* (temperatura 0,3, respuestas completas). Es lo que hace que no invente cuando le preguntan algo concreto.
- **Respuestas largas:** si el modelo se queda sin tokens, reintenta con más margen; al publicar, el texto se parte en varios mensajes sin cortar palabras al medio.
- **Precalentamiento:** el bot consulta la lista de modelos al arrancar, no en el primer mensaje: la primera respuesta tras un reinicio no se come la demora del listado.
- Los modelos con **thinking** (razonamiento previo) están excluidos: solo chat directo.

Para activarlo:
1. Clave gratis de Gemini en [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (cuenta Google, 2 min, sin tarjeta).
2. (Recomendado) Clave gratis de Groq en [console.groq.com/keys](https://console.groq.com/keys) como respaldo.
3. Agregá `GEMINI_API_KEY` y `GROQ_API_KEY` en el panel de Wispbyte (Startup → Variables) o en tu `.env` local.
4. (Opcional) `GEMINI_MODEL` / `GROQ_MODEL` para fijar modelos — por defecto el bot detecta solo los mejores disponibles.

Con `/status` ves qué modelo está usando cada IA.

**Sin clave configurada el bot funciona igual**: usa su repertorio local de respuestas. Si la IA falla o se queda sin cuota, también cae al respaldo automáticamente — nunca se queda mudo.

## Base de datos (MariaDB de la web)

El bot comparte la base de datos de la web TriGGer.Arena (`trigger-arena-db` en MariaDB). Usa **sus propias tablas con prefijo `bot_`** y nunca toca las tablas de la web:

| Tabla del bot | Para qué |
|---|---|
| `bot_data` | Respaldo maestro: config, warns, niveles, afk e interacciones (un snapshot JSON por servidor y almacén) |
| `bot_stats` | Estadísticas globales sueltas |
| `bot_cmd` | Bus de comandos web ↔ bot: la web encola comandos y el bot los ejecuta cada 5 s |

- Cada cambio local se sube a la base 3 segundos después (agrupa ráfagas de escrituras).
- Al arrancar, el bot compara local vs base y aplica la copia más nueva: si el host borra `data/`, todo se restaura solo desde MariaDB.
- **Las tablas se crean solas** al primer arranque (`CREATE TABLE IF NOT EXISTS`): no hace falta importar nada a mano. `sql/schema.sql` queda como referencia y para crearlas desde phpMyAdmin si el usuario no tiene permisos de `CREATE`.
- Cuando el bot es expulsado de un servidor, sus datos se limpian de ambos lados.

**Configuración:**
En Wispbyte (Startup → Variables) o en tu `.env` local:
```
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=trigger-arena-db
DB_USER=trigger-user
DB_PASSWORD=••••••••
```
Son las mismas credenciales que usa la web. El usuario necesita permisos de `SELECT/INSERT/UPDATE/DELETE` (+ `CREATE` la primera vez, o importá `sql/schema.sql` desde phpMyAdmin).

Restart. En el log vas a ver `Base de datos conectada: ...` y `/status` muestra el estado de la BD.

Sin variables `DB_*` el bot funciona igual, solo con archivos locales. **Seguridad:** el aislamiento con los datos de la web es por usuario de BD y prefijo `bot_`: todas las consultas van parametrizadas y la capa de BD valida tabla/columna contra una whitelist.

## Setup local

1. Instalar dependencias:
   ```
   npm install
   ```
2. Copiar `.env.example` a `.env` y completar:
   - `DISCORD_TOKEN` → token del bot (Discord Developer Portal → Bot → Reset Token)
   - `CLIENT_ID` → ID de la aplicación (Developer Portal → General Information → Application ID)
   - `GUILD_ID` → ID de tu servidor Discord (clic derecho en el servidor → Copiar ID, con modo desarrollador activado)
3. Invitar el bot al servidor con permisos de aplicaciones:
   ```
   https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands
   ```
4. Registrar los comandos slash (OPCIONAL — el bot los registra solo al arrancar):
   ```
   npm run register
   ```
5. Encender el bot:
   ```
   npm start
   ```

## Despliegue en Wispbyte

1. Subir el repo a GitHub (ya conectado) y en Wispbyte crear un servidor **Node.js** (el plan gratuito corre 24/7; 1 bot por server).
2. Subir el código con la **integración de GitHub**: en Files/Deploy poné la URL del repo (`https://github.com/fedegudi2022-blip/TriggerBOT`), branch `main`, y activá **auto-update on startup** para que cada reinicio haga pull.
3. En la pestaña **Startup**:
   - Comando de arranque: `node src/index.js`
   - Variables de entorno: `DISCORD_TOKEN` (es la única imprescindible; `CLIENT_ID` y `GUILD_ID` solo hacen falta si usás `npm run register` manual)
   - Las dependencias se instalan solas (hay `package.json`)
4. Start y mirar la consola: deberías ver la sesión iniciada y los comandos sincronizados en cada servidor.
5. Para actualizar: `git push` desde tu máquina → **Restart** en el panel (con auto-update hace pull solo).

> No hace falta subir `.env` a Wispbyte: las variables del panel llegan al bot igual (dotenv no las pisa).

**Importante:** nunca subir el `.env` a GitHub (ya está en `.gitignore`). Poner el token como variable en el panel de Wispbyte.

## Privacidad y datos

El bot está pensado para **un solo servidor**: la comunidad Trigger.

**Qué guarda y dónde:**

| Dato | Dónde vive |
|---|---|
| Configuración del server (`data/config.json`) | Disco local + respaldo en MariaDB (`bot_data`) |
| Historial de warns | Disco + MariaDB (`bot_data`) |
| XP, niveles, logros | Disco + MariaDB (`bot_data`) |
| Estado AFK y contadores de interacciones | Disco + MariaDB (`bot_data`) |
| Transcripts de tickets (.txt) | Canal de logs y DM del usuario; no se persiste en el bot |
| Logs de mensajes borrados/editados | Canal de logs del server; no se persiste en el bot |
| Ventanas de anti-spam/anti-raid, cooldowns, memoria de IA | Solo memoria; se pierden al reiniciar (intencional) |

**Servicios externos:**

- **Discord**: inherente al bot.
- **MariaDB de la web** (si está configurada): respaldo de los datos de la tabla de arriba, en tablas propias `bot_*`. La contraseña `DB_PASSWORD` es un secreto: nunca en logs (el logger la enmascara si un error la arrastra), capturas ni el repo.
- **Proveedores de IA** (solo si configurás `GROQ_API_KEY`/`GEMINI_API_KEY`): al mencionar al bot se envía tu mensaje, tu nombre visible, el canal, tus datos públicos del sistema de niveles (nivel, XP, puesto, racha) y el estado público de los servidores CS (desde su propia pregunta), más los últimos 6 turnos de la conversación con vos. No se envían IDs de Discord ni mensajes de otros usuarios. Sin claves configuradas, el chat usa solo respuestas locales y **nada sale del host**.
- **Reddit / APIs de GIFs**: solo peticiones anónimas de contenido público (memes, GIFs de interacciones).

**Retención:** los JSON locales viven mientras el bot esté en el server; al ser expulsado, sus datos se limpian del disco y de la base (`bot_data`). Los transcripts de tickets y los logs de moderación quedan en Discord (canal/DM) según la retención de Discord misma.
