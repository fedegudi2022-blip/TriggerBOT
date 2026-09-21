# TriggerBOT

Bot de Discord privado para la comunidad **Trigger**, hecho en Node.js con discord.js v14. La configuración y el historial de warns se guardan en archivos JSON simples (sin base de datos).

## Estructura

```
src/
├── index.js            # Punto de entrada: carga comandos y eventos automáticamente
├── deploy-commands.js  # Registra los comandos slash en Discord
├── store.js            # Config por servidor en data/config.json
├── warns.js            # Historial de warns en data/warns.json
├── commands/           # Un archivo por comando slash
├── events/             # Un archivo por evento (ready, logs, ...)
└── utils/
    ├── modlog.js       # Registro de acciones de moderación (mod-log)
    ├── log.js          # Registro de eventos generales (logs)
    ├── moderation.js   # Chequeos de jerarquía y avisos por DM
    └── replies.js      # Embeds con el estilo visual unificado del bot
```

> `data/` se crea solo y está en `.gitignore`: cada entorno (local/Wispbyte) tiene su propia configuración.

## Comandos

### General
| Comando | Qué hace | Quién lo usa |
|---|---|---|
| `/ping` | Latencia del bot | Todos |
| `/help` | Guía completa de comandos | Todos |
| Mencionar al bot (`@TriggerBOT`) | Charla con IA (si está configurada) o respuestas locales | Todos |
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

### Configuración (solo staff)
| Subcomando | Qué hace |
|---|---|
| `/config ver` | Muestra toda la configuración actual |
| `/config welcome` | Canal, mensaje y autorol de bienvenida. Variables: `{usuario}` `{servidor}` `{miembros}` |
| `/config modlog` | Canal donde se registran kick/ban/timeout/clear/warn |
| `/config logs` | Canal donde se registran mensajes borrados/editados, salidas, roles y apodos |
| `/config avisos` | Canal de notificaciones al staff (reservado para escaladas futuras) |
| `/config staff` | Roles admin/mod/helper del bot |
| `/config mute` | Rol de silenciado (si no definís uno, `/mute` crea el suyo) |
| `/config desactivar` | Apaga bienvenida, autorol, mod-log, logs, avisos o el rol de mute |

## Chat con IA (opcional)

El bot puede conversar cuando lo mencionás, con memoria de contexto por usuario (los últimos 6 turnos, se olvida a los 10 minutos). Si Google retira el modelo que usa, el bot detecta solo el reemplazo disponible — no hace falta tocar código.

1. Conseguí una clave gratis en [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (cuenta Google, 2 minutos, sin tarjeta).
2. Agregá la variable `GEMINI_API_KEY` en el panel de Wispbyte (Startup → Variables) o en tu `.env` local.
3. (Opcional) `GEMINI_MODEL` para fijar el modelo — por defecto el bot detecta solo el mejor modelo flash disponible (hoy: `gemini-3.6-flash`).

**Sin clave configurada el bot funciona igual**: usa su repertorio local de respuestas. Si la IA falla o se queda sin cuota, también cae al respaldo automáticamente — nunca se queda mudo.

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

## Privacidad

El bot está pensado para **un solo servidor**: la comunidad Trigger. Solo guarda configuración y warns en archivos JSON locales; no manda datos a ningún servicio externo.
