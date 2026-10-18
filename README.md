<div align="center">

# TriggerBOT

**El bot de la comunidad Trigger.Arena** — moderación, tickets, niveles, servidores CS 1.6 e IA, en un solo lugar.

![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)
![tests](https://img.shields.io/badge/tests-758%20passing-57f287)
![dependencias](https://img.shields.io/badge/runtime-3%20deps-2c2f33)

[Comandos](docs/COMANDOS.md) · [IA](docs/IA.md) · [Arquitectura](docs/ARQUITECTURA.md) · [Operación](docs/OPERACION.md) · [Integración web](docs/INTEGRACION-WEB.md)

</div>

---

## Qué hace

- 🛡️ **Moderación con auditoría** — warn, ban, timeout, mute, clear y más, con confirmación, deshacer, jerarquía y casos numerados en el mod-log.
- 🎫 **Tickets de soporte** — panel con tipos (soporte, apelación, cheater), canales privados, reclamo, motivo de cierre, transcript HTML, auto-cierre por inactividad y encuesta con estadísticas para el staff.
- 📈 **Niveles y logros** — XP por texto y voz, 16 logros, rangos, roles automáticos y ranking con podios.
- 🤖 **Chat con IA** — responde con datos reales del servidor, base de conocimiento propia, búsqueda web y acciones de moderación confirmadas por el staff.
- 🎮 **Servidores CS 1.6** — estado en vivo por el protocolo de Valve, panel que se actualiza solo e IP lista para copiar.
- 🔊 **Voz y estadísticas** — canales temporales estilo VoiceMaster y contadores en vivo en el nombre de canales de lectura.
- 🎉 **Sorteos** — panel con botones, requisito por rol, cierre automático y anuncio de ganadores.
- 🧹 **Automod** — anti-spam, anti-raid y filtros de invitaciones, links, menciones, mayúsculas y repetidos.

## Stack

Node 22 · discord.js v14 · CommonJS · MariaDB opcional para respaldo · tests con el runner nativo (sin frameworks).

## Empezar

```bash
npm ci
cp .env.example .env   # completá DISCORD_TOKEN
npm start
```

Los comandos slash se registran solos al arrancar; `npm run register` solo hace falta para forzarlo. Para invitarlo:

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot+applications.commands
```

## Variables de entorno

| Variable | Para qué |
| --- | --- |
| `DISCORD_TOKEN` | **Obligatoria.** Token del bot |
| `CLIENT_ID`, `GUILD_ID` | Solo para registrar comandos a mano |
| `PRESENCE_INTENT` | Conteo de «en línea» en `/stats` (`false` si el portal no lo tiene habilitado) |
| `GROQ_API_KEY`, `GEMINI_API_KEY`, … | Chat con IA: alcanza una clave, más claves = más respaldo |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Respaldo en MariaDB (sin esto, solo archivos locales) |
| `IA_LIMITE_DIARIO`, `LOG_LEVEL` | Tope de respuestas por día y nivel de log |

Todas las opciones y sus valores por defecto están en [`.env.example`](.env.example) y en [docs/OPERACION.md](docs/OPERACION.md).

## Desarrollo

```bash
npm test        # 758 tests, aislados del data/ real y sin red
npm run lint    # errores reales, no estilo
npm run format  # Prettier
npm run check   # lint + tests: el mínimo antes de subir cambios
```

Cada push a `main` corre `npm run check` en GitHub Actions. Como el bot se actualiza solo en cada reinicio, esa barrera evita que un commit roto baje producción.

## Despliegue

En Wispbyte, con la imagen **Node 22** (`nodejs_22`):

1. Conectá el repo por GitHub, branch `main`, con **auto-update on startup**.
2. Comando de arranque: `node src/index.js`.
3. Cargá `DISCORD_TOKEN` en **Startup → Variables** y dale **Start**.

Detalle completo en [docs/OPERACION.md](docs/OPERACION.md).

## Documentación

| Documento | Contenido |
| --- | --- |
| [Comandos](docs/COMANDOS.md) | Catálogo completo y cómo funciona cada sistema |
| [IA](docs/IA.md) | Chat, base de conocimiento, búsqueda web, proveedores y límites |
| [Arquitectura](docs/ARQUITECTURA.md) | Cómo está hecho el bot por dentro |
| [Operación](docs/OPERACION.md) | Variables, base de datos, despliegue y privacidad |
| [Integración web](docs/INTEGRACION-WEB.md) | Panel web ↔ bot sobre la misma MariaDB |

## Privacidad

Los datos de configuración, warns, niveles y casos viven en el servidor y, si está configurada, en tablas propias `bot_*` de MariaDB. Sin claves de IA, nada sale del host. El detalle de qué se guarda, qué se envía a cada servicio y por cuánto tiempo está en [docs/OPERACION.md](docs/OPERACION.md#privacidad-y-datos).
