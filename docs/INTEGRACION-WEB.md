# Integración web ↔ bot (TriGGer.Arena)

Cómo mostrar **información real del bot y del servidor de Discord** en la página y dejar que el staff **edite toda la configuración del bot** desde la web. No hace falta ninguna API nueva: ambos lados ya comparten la base MariaDB (`trigger-arena-db`).

```
┌─────────────┐   INSERT bot_cmd    ┌──────────────┐   ejecuta con validaciones
│  La web      │ ──────────────────▶ │  bot_cmd     │ ─────────────────────────▶ Discord
│ (PHP, webhost)│                     └──────────────┘
│              │   SELECT cada 5 s   ┌──────────────┐
│              │ ◀────────────────── │  bot_data    │ ◀── el bot publica estado+config
└─────────────┘                     └──────────────┘
```

- **Lectura** (info real): la web lee directo de `bot_data`. El bot publica un snapshot **cada 5 segundos**.
- **Escritura** (configurar): la web inserta una fila en `bot_cmd` y el bot la ejecuta en ≤ 5 s con las mismas validaciones que `/config`. El resultado queda en la misma fila.

La autenticación es el usuario MySQL que la web ya tiene. No hay puertos abiertos ni tokens nuevos.

---

## 1. Conexión

```php
<?php
// db.php — mismas credenciales que ya usa la web para sus tablas.
$pdo = new PDO(
  'mysql:host=DB_HOST;dbname=trigger-arena-db;charset=utf8mb4',
  'DB_USER',
  'DB_PASSWORD',
  [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
);
```

Las tablas del bot son solo tres, con prefijo `bot_` (nunca se tocan las de la web):

| Tabla | Para qué |
|---|---|
| `bot_data` | Snapshot por servidor y almacén: `config:GUILD_ID`, `bot_estado:_global`, etc. |
| `bot_cmd` | Cola de comandos web → bot, con `resultado` por fila |
| `bot_stats` | Contadores sueltos del bot |

---

## 2. Leer el estado real (bot + servidor de Discord)

El estado completo del bot está en la fila `clave = 'bot_estado:_global'` de `bot_data`, columna `datos` (JSON). Se actualiza **cada 5 segundos** mientras el bot esté online.

```php
<?php
// api/bot/estado.php
require __DIR__ . '/../db.php';

$fila = $pdo->query("SELECT datos, version FROM bot_data WHERE clave = 'bot_estado:_global'")->fetch();
if (!$fila) { http_response_code(404); exit(json_encode(['error' => 'el bot todavía no publicó estado'])); }

$estado = json_decode($fila['datos'], true);
header('Content-Type: application/json; charset=utf-8');
echo json_encode($estado, JSON_UNESCAPED_UNICODE);
```

### Qué contiene (todas claves reales, no de muestra)

```jsonc
{
  "online": true,
  "pingMs": 55,                       // latencia con la API de Discord
  "uptimeSeg": 86400,                 // segundos encendido
  "memoriaMb": 210,
  "versionNodo": "v19.9.0",
  "comandos": 44,
  "bot": {                            // el propio bot
    "id": "123456789012345678",
    "nombre": "Trigger",
    "avatar": "https://cdn.discordapp.com/...",
    "estado": "online"
  },
  "ia": {                             // proveedores de IA configurados (o null)
    "groq": "openai/gpt-oss-120b",
    "gemini": null,
    "stats": { "groq": 12, "gemini": 0, "local": 3 },
    "salud": {                        // salud medida desde el último arranque
      "groq": {
        "enPausa": false,             // true = el bot lo está salteando (clave/cuota)
        "motivoPausa": null,
        "p50": 412,                   // mediana real de respuesta, en ms
        "p95": 890,
        "muestras": 12,
        "errores": 1,
        "modelosCaidos": ["llama-3.3-70b-versatile"]
      },
      "gemini": { "enPausa": false, "p50": null, "p95": null, "muestras": 0, "errores": 0, "modelosCaidos": [] }
    }
  },
  "baseDatos": { "ok": true, "subidasOk": 142, "ultimoError": null },
  "servidores": 1,
  "guilds": [                         // UN ELEMENTO POR SERVER DE DISCORD
    {
      "id": "972931405548912690",
      "nombre": "TriGGer.Arena",
      "miembros": 150,                // ← contador real de miembros
      "icono": "https://cdn.discordapp.com/icons/.../...png",
      "banner": "https://... | null",
      "descripcion": "... | null",
      "dueñoId": "111111111111111111",
      "creadoEn": 1650000000000,      // ms; fecha de creación del server
      "boosts": 3,
      "nivelBoost": 1,
      "canales": [ { "id": "...", "nombre": "general", "tipo": 0 }, ... ],  // hasta 500
      "totalCanales": 23,
      "roles": [ { "id": "...", "nombre": "Staff", "color": "#ff0000", "posicion": 5 }, ... ],
      "emojis": [ { "id": "...", "nombre": "pog", "animado": false }, ... ],
      "idCanalSistema": "...",
      "idCanalReglas": "...",
      "verificacion": 2
    }
  ],
  "estadisticas": {                   // misma clave que el guild correspondiente
    "972931405548912690": {
      "niveles": {                    // sistema de XP del bot
        "usuarios": 87,
        "xpTotal": 152340,
        "mensajesConXp": 9120,
        "top": [ { "userId": "...", "xp": 4200, "nivel": 6, "mensajes": 310 }, ... ]  // top 10
      },
      "warns": {
        "total": 12,
        "usuarios": 9,
        "porUsuario": [ { "usuarioId": "...", "cantidad": 3 }, ... ]
      },
      "afk": { "cantidad": 4, "usuarios": ["...", "..."] },
      "interacciones": { "total": 231, "porAccion": { "beso": 40, "abrazo": 31, ... } },
      "antiSpamConfig": { "activado": false, "spamMensajes": 5, "spamSegundos": 5, ... }
    }
  },
  "ultimaRevision": "2026-09-22T03:34:20.000Z"
}
```

Con eso la página puede mostrar: nombre, icono y banner reales del grupo, contador de miembros, boosts, lista de canales y roles (con colores), top 10 de niveles, warns pendientes, quién está AFK, y la salud del bot (ping/uptime/IA/BD).

> **Cache:** la web puede pedir esta info con `Cache-Control: max-age=5` — es la frecuencia natural de actualización.

---

## 3. Leer la configuración actual del bot

La config completa por servidor está en `clave = 'config:GUILD_ID'` (columna `datos`, JSON; `version` = fecha del último cambio en ms):

```php
<?php
// api/bot/configuracion.php?guild_id=...
require __DIR__ . '/../db.php';
$guild = preg_replace('/\D/', '', $_GET['guild_id'] ?? '');

$stmt = $pdo->prepare("SELECT datos, version FROM bot_data WHERE clave = ?");
$stmt->execute(["config:$guild"]);
$fila = $stmt->fetch();
if (!$fila) { http_response_code(404); exit(json_encode(['error' => 'sin configuración'])); }

header('Content-Type: application/json; charset=utf-8');
echo json_encode([
  'config' => json_decode($fila['datos'], true),
  'actualizadaEn' => date('c', (int)($fila['version'] / 1000)),
], JSON_UNESCAPED_UNICODE);
```

Claves útiles dentro de `config` (todas pueden venir ausentes = sin configurar):

| Clave | Significado |
|---|---|
| `welcome.channelId`, `welcome.message`, `autorole` | Bienvenida y autorol |
| `modlog`, `logs`, `avisosChannel` | Canales de registro y avisos |
| `adminRole`, `modRole`, `helperRole` | Roles de staff del bot |
| `muteRole` | Rol de silenciado |
| `iaActivada` | Chat con IA prendido/apagado |
| `canalNiveles`, `fraseDelDia.canalId`, `fraseDelDia.hora`, `fraseDelDia.frases[]` | Niveles y frase del día |
| `proteccion.*` | Anti-spam/anti-raid (umbrales y acciones) |
| `tickets.categoriaId`, `tickets.canalLogs` | Tickets |
| `servidores.lista[]`, `servidores.monitoreo` | Servers CS 1.6 del panel |

Para los selectores de canal/rol usá los arrays `guilds[].canales` y `guilds[].roles` del estado (sección 2): ahí están id + nombre de todo lo que existe en el server.

---

## 4. Cambiar la configuración desde la web (`set_config`)

Un solo comando cubre **toda** la config: `set_config` con `{ campo: valor, ... }`. El bot valida cada campo contra su esquema (rangos, snowflakes, enums) e ignora los desconocidos.

```php
<?php
// api/bot/guardar.php — POST { guild_id, campos: { modlog: "123...", iaActivada: true, ... } }
require __DIR__ . '/../db.php';

$entrada = json_decode(file_get_contents('php://input'), true);
$guild   = preg_replace('/\D/', '', $entrada['guild_id'] ?? '');
$campos  = $entrada['campos'] ?? [];
if (!$guild || !$campos) { http_response_code(400); exit(json_encode(['error' => 'faltan datos'])); }

$stmt = $pdo->prepare(
  "INSERT INTO bot_cmd (comando, guild_id, argumentos, creada_por)
   VALUES ('set_config', ?, ?, ?)"
);
$stmt->execute([
  $guild,
  json_encode($campos, JSON_UNESCAPED_UNICODE),
  'web:' . ($_SESSION['usuario'] ?? 'anon'),   // auditoría: quién lo pidió
]);
echo json_encode(['id' => (int)$pdo->lastInsertId()]);
```

### Para saber si funcionó

El bot procesa la fila en ≤ 5 s y llena `procesado_en` y `resultado`:

```php
<?php
// api/bot/resultado.php?id=123
require __DIR__ . '/../db.php';
$stmt = $pdo->prepare("SELECT procesado_en, resultado FROM bot_cmd WHERE id = ?");
$stmt->execute([(int)$_GET['id']]);
$fila = $stmt->fetch();
echo json_encode([
  'pendiente' => !$fila || $fila['procesado_en'] === null,
  'resultado' => $fila ? json_decode($fila['resultado'], true) : null,
  // resultado = { "ok": true, "detalle": "config actualizada: modlog, iaActivada" }
]);
```

### Campos aceptados por `set_config` (el esquema completo)

| Campo | Tipo | Validación |
|---|---|---|
| `bienvenida`, `modlog`, `logs`, `avisosChannel`, `canalNiveles`, `canalFrases` | canal | ID numérico de canal |
| `autorol`, `adminRole`, `modRole`, `helperRole`, `muteRole` | rol | ID numérico de rol |
| `ticketsCategoria`, `ticketsLogs` | canal | ID numérico |
| `welcomeMessage` | texto | máx. 1000 caracteres |
| `horaFrases` | int | 0–23 |
| `iaActivada`, `proteccionActivada`, `accionesRapidas`, `servidoresAlertas` | bool | true/false (toma `'true'`/`1`) |
| `accionSpam` | enum | `aviso` `timeout` `mute` `kick` `ban` |
| `accionRaid` | enum | `nada` `kick` `ban` |
| `spamMensajes` | int | 3–20 |
| `spamSegundos` | int | 2–120 |
| `raidJoins` | int | 3–50 |
| `raidSegundos` | int | 10–600 |

Cualquier campo inválido o desconocido se ignora sin romper los demás; `resultado.detalle` lista qué se aplicó y qué se ignoró. Un solo botón "Guardar" puede mandar varios campos juntos.

---

## 5. Resto de comandos disponibles

Todos se insertan igual que en la sección 4, cambiando `comando` y `argumentos`:

| Comando | Argumentos | Qué hace |
|---|---|---|
| `publicar_anuncio` | `{ canal_id, mensaje, titulo? }` | Publica un embed en un canal (máx. 4000 chars) |
| `set_canales` | `{ modlog?, logs?, avisos?, canalNiveles?, bienvenida? }` | Cambia varios canales a la vez |
| `set_mute_role` | `{ rol_id }` | Rol de silenciado |
| `set_proteccion` | `{ activado?, accionSpam?, accionRaid?, spamMensajes?, ... }` | Anti-spam/raid (igual que set_config) |
| `set_ia` | `{ activada }` | Prende/apaga el chat con IA |
| `agregar_frase` | `{ texto, autor? }` | Suma frase al rotativo (máx. 100, 300 chars) |
| `quitar_frase` | `{ numero }` | Elimina la frase N (desde 1) |
| `agregar_server_cs` | `{ nombre, host, puerto?, modo?, descripcion?, imagen? }` | Server del panel CS 1.6 (máx. 20) |
| `quitar_server_cs` | `{ numero }` | Elimina el server N |
| `recargar_config` | `{}` | Sin-op: los cambios ya aplican en vivo |

> **Consejo de UI:** para editar las frases o los servers CS desde la web, leé la lista actual desde `config:GUILD_ID` (sección 3) y para borrar usá el número de posición (1-based) tal como se muestra en la lista.

---

## 6. Notas de operación

- **Latencia:** cambios y estado viajan en 3–5 s (el tick del puente). Es un panel de administración, no chat en vivo.
- **Comandos vencidos:** si el bot está apagado, las filas de `bot_cmd` sin procesar tras 60 s se marcan con `resultado = { ok: false, error: "comando vencido..." }` cuando vuelva. Mostrá ese estado en la UI.
- **Limpieza:** de vez en cuando conviene `DELETE FROM bot_cmd WHERE procesado_en IS NOT NULL AND procesado_en < NOW() - INTERVAL 7 DAY`.
- **Multiples servers:** todos los comandos (menos `recargar_config`) requieren `guild_id`; el estado trae un elemento por server con sus estadísticas.
- **Seguridad:** la web debe validar sesión/staff ANTES de insertar en `bot_cmd` — cualquiera con acceso a la tabla puede mandar comandos al bot. El lado del bot ya valida todos los valores (rangos, tipos, whitelists), pero la autorización de "quién puede tocar" es de la web.
