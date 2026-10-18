# Operación

Todo lo necesario para correr, actualizar y auditar el bot. La plantilla completa de variables está en [`.env.example`](../.env.example).

## Variables de entorno

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `DISCORD_TOKEN` | Sí | Token del bot (Developer Portal → Bot → Reset Token) |
| `CLIENT_ID` | Solo para `npm run register` | ID de la aplicación |
| `GUILD_ID` | Solo para `npm run register` | ID del servidor |
| `PRESENCE_INTENT` | No | Habilita el conteo de «en línea» de `/stats`. Si el portal no tiene el intent habilitado, `false` permite arrancar igual |
| `IA_LIMITE_DIARIO` | No | Tope de respuestas de IA por día (300 por defecto) |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY` | No | Chat con IA. Alcanza una; cada una de más suma respaldo |
| `GEMINI_MODEL`, `GROQ_MODEL`, … | No | Fijan un modelo puntual |
| `KB_SEMANTICO`, `KB_SEMANTICO_UMBRAL`, `KB_SEMANTICO_TITULO` | No | Búsqueda por significado de la base de conocimiento |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | No | Respaldo en MariaDB (sin esto, solo archivos locales) |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` |

En Wispbyte se cargan en **Startup → Variables**; en local, en `.env`. Las variables del panel no se pisan con `.env`.

## Base de datos (MariaDB)

El bot comparte la base de la web TriGGer.Arena y usa **solo sus tablas con prefijo `bot_`**:

| Tabla | Para qué |
| --- | --- |
| `bot_data` | Respaldo maestro: config, warns, niveles, afk, casos, notas e interacciones (un snapshot JSON por servidor y almacén) |
| `bot_stats` | Estadísticas globales sueltas (presupuesto de IA, contadores) |
| `bot_cmd` | Bus de comandos web ↔ bot: la web encola y el bot ejecuta cada 5 s |

- Cada cambio local se sube 3 segundos después (agrupa ráfagas).
- Al arrancar se compara local contra la base y gana la copia más nueva: si el host borra `data/`, todo se restaura solo.
- Las tablas se crean solas al primer arranque. `sql/schema.sql` queda como referencia o para crearlas desde phpMyAdmin.
- Al expulsar al bot de un servidor, sus datos se limpian de ambos lados.
- **Seguridad:** consultas parametrizadas y validación de tabla/columna contra una whitelist. El usuario necesita `SELECT/INSERT/UPDATE/DELETE` (y `CREATE` la primera vez).

## Despliegue en Wispbyte

1. Crear un servidor **Node.js** con la imagen **Node 22** (`nodejs_22`). Con Node 19 el `npm install` avisa `EBADENGINE` y no hay parches de seguridad.
2. Conectar el repo por GitHub (`https://github.com/fedegudi2022-blip/TriggerBOT`), branch `main`, con **auto-update on startup**.
3. En **Startup**: comando `node src/index.js` y las variables de entorno (`DISCORD_TOKEN` es la única imprescindible).
4. **Start** y revisar la consola: sesión iniciada y comandos sincronizados en cada servidor.
5. Para actualizar: `git push` → **Restart** (con auto-update hace pull solo).

#### Comando de arranque recomendado

El comando por defecto de Wispbyte hace `git pull` sin estrategia y `npm install` con las dependencias de desarrollo. Eso es lo que llena la consola de avisos (`hint: Pulling without specifying…` y los `npm WARN EBADENGINE` de ESLint). Reemplazalo por:

```bash
git -c pull.ff=only pull && npm install --omit=dev --no-audit --no-fund --loglevel=error && node src/index.js
```

- `pull.ff=only` elimina el aviso de estrategia y falla limpio si el historial divergió (en vez de crear un merge a ciegas en el servidor).
- `--omit=dev` no instala ESLint/Prettier en producción: menos avisos y arranque más rápido.
- `--loglevel=error` silencia el progreso de npm (`reify: timing…`).

> **El `EBADENGINE` del propio bot** (`package: 'triggerbot@1.0.0'`) desaparece solo cuando la imagen del panel es `nodejs_22`: lo emite npm al comparar la versión del host, no el código. Con Node 19 el bot igual arranca, pero `/diag` muestra el aviso «Node fuera de soporte» con esa misma instrucción.

> Nunca subir `.env` al repo: ya está en `.gitignore`. El token va como variable del panel.

## Diagnóstico de los logs de arranque

Guía rápida para las líneas que más aparecen. **Un proveedor caído no es un error del bot**: lo aparta y sigue con el siguiente, por eso el bot nunca deja de responder.

| Línea del log | Qué significa | Qué hacer |
| --- | --- | --- |
| `npm WARN EBADENGINE … required: { node: '>=22' }` | El host corre Node 19 y el proyecto pide 22 | Startup → imagen `nodejs_22` (es el único cambio que lo elimina) |
| `hint: Pulling without specifying how to reconcile…` | `git pull` sin estrategia configurada | usar el comando de arranque recomendado (`git -c pull.ff=only pull`) |
| `reify: timing…` o barras de progreso | npm en modo verboso | `npm install --loglevel=error` |
| `Cerebras: la cuenta no tiene acceso (pago requerido)` | La API devolvió 402: el plan no incluye esos modelos | Habilitar facturación en Cerebras o **quitar** `CEREBRAS_API_KEY` |
| `OpenRouter: la clave de API no es válida o fue revocada` | Clave incorrecta, vencida o revocada | Generar otra en OpenRouter o quitar la variable |
| `Mistral: cuota agotada (se reintenta en un minuto)` | 429 temporal del plan gratuito | Nada: vuelve solo; si es diario, revisá el plan |
| `Gemini no pasó la prueba: … HTTP 503` | Saturación transitoria de Google | Nada: el bot aparta Gemini un minuto y sigue con Groq |
| `Reconectando con Discord (intento N)` | El gateway se reconecta | Mirar la línea `Conexión perdida … código NNNN`: **1006** = red del host, **4004** = token inválido, **4000/4014** = intents |

Las líneas de IA ahora son **una por proveedor y por evento**: el detalle del error se resume en una sola línea (los JSON formateados de Gemini ya no ocupan cinco renglones) y un error de cuenta no se repite modelo por modelo.

## Privacidad y datos

El bot está pensado para un solo servidor: la comunidad Trigger.

| Dato | Dónde vive |
| --- | --- |
| Config, warns, niveles, AFK, interacciones, notas y casos | Disco local + MariaDB (`bot_data`) |
| Transcripts de tickets (`.txt`) | Canal de logs y DM del usuario; no se persiste en el bot |
| Logs de mensajes borrados/editados | Canal de logs del servidor; no se persiste en el bot |
| Ventanas de anti-spam/anti-raid, cooldowns y memoria de IA | Solo memoria; se pierden al reiniciar |

**Servicios externos:**

- **Discord**: inherente al bot.
- **MariaDB de la web** (si está configurada): respaldo de los datos de la tabla, en tablas propias `bot_*`. La contraseña es un secreto y el logger la enmascara si un error la arrastra.
- **Proveedores de IA** (solo con clave configurada): al mencionar al bot se envía el mensaje, tu nombre visible, el canal, tus datos públicos de niveles y el estado público de los servidores CS, más los últimos 6 turnos de la conversación. No se envían IDs de Discord ni mensajes de otros usuarios. Sin claves, nada sale del host.
- **Reddit y APIs de GIFs**: solo pedidos anónimos de contenido público.

**Retención:** los JSON locales viven mientras el bot esté en el servidor; al ser expulsado se limpian del disco y de la base. Los transcripts y logs quedan en Discord según su propia retención.
