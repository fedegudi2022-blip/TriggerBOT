# TriggerBOT

Bot de Discord privado para la comunidad **Trigger**, hecho en Node.js con discord.js v14, **sin base de datos** (todo en memoria).

## Estructura

```
src/
├── index.js            # Punto de entrada: carga comandos y eventos automáticamente
├── deploy-commands.js  # Registra los comandos slash en Discord
├── commands/           # Un archivo por comando slash
│   └── ping.js
├── events/             # Un archivo por evento (ready, messageCreate, ...)
│   ├── ready.js
│   ├── messageCreate.js
│   └── guildMemberAdd.js
├── utils/
│   └── modlog.js       # Registro de acciones de moderación
└── store.js            # Config por servidor guardada en data/config.json (JSON simple)
```

> `data/` se crea solo y está en `.gitignore`: cada entorno (local/Wispbyte) tiene su propia configuración.

## Comandos

| Comando | Qué hace | Quién lo usa |
|---|---|---|
| `/ping` | Latencia del bot | Todos |
| `/config ver` | Muestra la configuración actual | Staff |
| `/config welcome` | Canal, mensaje y autorol de bienvenida. Variables: `{usuario}` `{servidor}` `{miembros}` | Staff |
| `/config modlog` | Canal donde se registran kick/ban/timeout/clear | Staff |
| `/config staff` | Roles admin/mod/helper del bot | Staff |
| `/config desactivar` | Apaga bienvenida, autorol o mod-log | Staff |
| `/kick usuario [razon]` | Expulsa a un usuario | Mods (permiso Discord) |
| `/ban usuario [razon] [borrar_dias]` | Banea y opcionalmente borra mensajes | Mods |
| `/timeout usuario duracion [razon]` | Silencia de 5 min a 28 días | Mods |
| `/clear cantidad [usuario] [razon]` | Borra hasta 100 mensajes recientes | Mods |

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
4. Registrar los comandos slash:
   ```
   npm run register
   ```
5. Encender el bot:
   ```
   npm start
   ```

## Despliegue en Wispbyte

1. Subir el repo a GitHub (ya conectado) y en Wispbyte crear un servidor **Node.js** con "Deploy desde GitHub".
2. En la pestaña **Startup**:
   - Comando de arranque: `npm start` (o `node src/index.js`)
   - Variables de entorno: `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` (sin `export`, solo nombre=valor)
3. Comandos a correr tras actualizar código:
   ```
   npm install && npm run register && npm start
   ```

**Importante:** nunca subir el `.env` a GitHub (ya está en `.gitignore`). Poner el token como variable en el panel de Wispbyte.

## Privacidad

El bot está pensado para **un solo servidor**: la comunidad Trigger. No se registran datos en ningún lado; todo vive en memoria mientras el proceso está corriendo.
