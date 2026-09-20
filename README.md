# TriggerBOT

Bot de Discord privado para la comunidad **Trigger**, hecho en Node.js con discord.js v14, **sin base de datos** (todo en memoria).

## Estructura

```
src/
├── index.js            # Punto de entrada: carga comandos y eventos automáticamente
├── deploy-commands.js  # Registra los comandos slash en Discord
├── commands/           # Un archivo por comando slash
│   └── ping.js
└── events/             # Un archivo por evento (ready, messageCreate, ...)
    ├── ready.js
    └── messageCreate.js
```

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
