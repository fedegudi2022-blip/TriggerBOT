# Comandos y sistemas

Referencia completa de lo que hace el bot. La guía viva es **`/help user`** y **`/help staff`** dentro de Discord: se arma sola desde los comandos cargados y nunca queda desactualizada.

- **Público** = cualquiera del servidor.
- **Staff** = dueño, quien tenga *Gestionar servidor*, o los roles admin/mod/helper configurados en `/config`.

## Información

| Comando | Qué hace | Permisos |
| --- | --- | --- |
| `/help user [comando]` | Guía por categorías; con `comando` muestra el detalle y el permiso que exige | Público |
| `/help staff [comando]` | Guía completa, incluida moderación y configuración (respuesta efímera) | Staff |
| `/ping` | Latencia con indicador de calidad y botón de refresco | Público |
| `/status` | Estado del bot: modelos de IA, latencia, tiempo encendido y uso | Público |
| `/userinfo [usuario]` | Ficha de usuario: fechas, roles, permisos y warns. El staff ve además notas internas y últimos casos | Público |
| `/serverinfo` | Ficha del servidor: dueño, canales, roles, boosts | Público |
| `/avatar [usuario]` | Avatar en grande con link de descarga | Público |
| `/redes` | Redes oficiales de la comunidad con botones de link directo | Público |
| `/web` | Link del sitio oficial con botón directo | Público |

## Moderación

| Comando | Qué hace |
| --- | --- |
| `/warn usuario [razon]` | Advierte. Al 3.er warn: timeout de 1 h automático (umbral configurable en `/config`) |
| `/warnings usuario` | Historial paginado con botones |
| `/unwarn usuario numero [razon]` | Elimina una advertencia del historial |
| `/nota agregar/ver/quitar` | Notas internas. **No cuentan** para el silencio automático |
| `/casos [caso] [usuario]` | Un caso del mod-log por número, o el historial de una persona |
| `/logs buscar [accion] [desde] [pagina]` | Filtra casos por acción, usuario, moderador y antigüedad |
| `/kick usuario [razon]` | Expulsa |
| `/ban usuario [razon] [borrar_dias]` | Banea y opcionalmente borra mensajes |
| `/unban usuario_id [razon]` | Revoca un baneo por ID |
| `/softban usuario [borrar_dias] [razon]` | Expulsa borrando sus mensajes (ban + unban) |
| `/tempban usuario duracion [razon]` | Baneo temporal (`30m`, `12h`, `7d`): se levanta solo al vencer |
| `/timeout usuario duracion [razon]` | Silencia de 5 min a 28 días, o levanta el silencio |
| `/mute usuario [razon]` | Silencia con rol (crea el rol *Silenciado* si no existe) |
| `/unmute usuario [razon]` | Quita el silencio |
| `/clear cantidad [usuario] [razon]` | Borra hasta 100 mensajes recientes |
| `/lockdown bloquear/desbloquear [canal]` | Cierra o reabre un canal, restaurando el estado anterior |
| `/slowmode segundos [canal]` | Modo lento de 0 s a 6 h |
| `/sanciones` | Quién está silenciado ahora |

**Cómo responden:**

- **Confirmación y deshacer:** `/ban`, `/softban`, `/kick`, `/mute`, `/clear` y `/lockdown bloquear` piden confirmación con botones antes de tocar Discord. Después ofrecen **Deshacer** para lo reversible (desbanear, quitar el rol Silenciado, desbloquear); un kick o un borrado de mensajes no se pueden deshacer con la API.
- **Jerarquía:** no se puede moderar a alguien con rol igual o superior, y el bot necesita el permiso concreto y un rol por encima del objetivo.
- **Honestidad:** si Discord rechaza la acción, el bot muestra el motivo real y registra el caso como rechazado. Nunca confirma algo que no pasó.
- **Transparencia:** la confirmación es pública y suma `silencioso:true` para hacerla privada; el DM al sancionado se manda solo si la sanción se aplicó.
- **Auditoría:** todo intento queda en el mod-log con número de caso, aplicado o no.

> Los comandos de staff quedan visibles en el selector a propósito: la autorización es interna (`/config`) para que un moderador por rol no pierda el comando. Para ocultárselos al resto hay que hacerlo por rol en **Server Settings → Integrations → TriggerBOT**; Discord no permite que las apps manejen esa visibilidad.

## Tickets de soporte

Se arma en 3 pasos: `/ticket logs` (dónde quedan los transcripts) → `/ticket categoria` (dónde se crean los canales) → `/ticket publicar`.

- **Panel con selector de tipo:** Soporte, Apelación o Reporte de cheater. Cada uno pide su formulario y crea un canal privado `soporte-001` / `apelacion-002` / `reporte-003`, visible solo para quien lo abrió y el staff. Un ticket abierto por persona. También existe `/reportar usuario pruebas [adjunto]`.
- **Para el staff:** botón **Reclamar** (deja el ticket a nombre de quien lo atiende) y **Agregar usuario** (acceso por ID o mención).
- **Al cerrar:** resumen (tipo, quién lo abrió/atendió/cerró, duración, mensajes), transcript `.txt` al canal de logs, DM al usuario con una encuesta 1-5 y borrado del canal 30 s después.
- **Personalizable:** `/ticket mensaje` cambia el texto del panel; también se edita desde `/config → Tickets de soporte`.

## Protección automática (anti-spam y anti-raid)

Se activa desde `/config → Anti-spam y anti-raid` (apagada por defecto).

- **Anti-spam:** al superar el umbral (5 mensajes en 5 s por defecto) borra la ráfaga y aplica la acción elegida (borrar / timeout 10 min / silenciar / expulsar / banear), avisando al canal de staff. El staff con *Gestionar mensajes* está exento y cada usuario tiene 30 s de gracia entre castigos.
- **Automod por contenido:** cinco filtros independientes (invitaciones, links, menciones masivas, mayúsculas y mensajes repetidos). Borran y avisan; no aplican sanciones.
- **Anti-raid:** si entran demasiadas cuentas en una ventana (8 en 60 s por defecto) alerta con la lista de ingresos, marcando cuentas de menos de 7 días. Opcionalmente puede expulsar o banear cuentas nuevas sin roles.
- Todo queda en el mod-log como acción del bot, y el resultado informado es siempre el real (si no pudo borrar, lo dice).

## Canales de voz temporales

Se activan con `/voz activar`: el bot crea un canal **«➕ Crear canal»** y, al entrar alguien, le da su propio canal temporal con un panel de controles.

- **Controles:** renombrar, límite de usuarios (0-99), cerrar/abrir, expulsar, transferir propiedad, reclamar (si el dueño se fue) y borrar.
- **Automático:** si el dueño se va y queda gente, la propiedad pasa al primer humano; si el canal queda vacío se borra solo (2 s de gracia). Un usuario tiene un solo canal a la vez.
- **Categoría y formato:** `/voz categoria` y `/voz formato`. Los canales existentes se mueven solos al cambiar la categoría.
- **Contador en el nombre:** «· 3» o «· 3/5» con límite, actualizado con la cola de renombres de Discord (2 por canal cada 10 min).
- **Registro:** `/voz logs fallos|todo|nada`. Por defecto solo se registran los fallos.
- **Límites:** 25 canales temporales por servidor; los activos sobreviven reinicios y se limpian los vacíos al arrancar.

## Canales de estadísticas

`/stats activar` crea una categoría **📊 Estadísticas** con canales de voz de solo lectura cuyo nombre lleva el número: 👥 Miembros · 🟢 En línea · 🎭 Roles.

- **Métricas:** `miembros`, `humanos`, `enLinea`, `roles`, `canales` y `boosts` (`/stats metricas lista`).
- **Refresco cada 10 minutos**, el máximo que permite Discord; si el cupo de renombres está usado, el cambio queda agendado con el valor más nuevo.
- **Sin datos no se inventa:** un canal que no se pudo medir muestra `—` y `/stats estado` explica por qué.
- **Gestión:** `/stats estado` (canales, Presence Intent, último censo, diagnóstico), `/stats refrescar` (fuerza una pasada e informa qué se renombró) y `/stats desactivar [borrar]`.
- **Presence Intent:** para «en línea» hay que habilitarlo en el portal de Discord. Si no está habilitado, `PRESENCE_INTENT=false` permite arrancar igual (el resto de las métricas sigue funcionando).

El conteo de humanos y conectados sale de un censo: una foto completa al arrancar y cada 6 h, y después los eventos de presencia lo mantienen al día. Descargar la lista entera en cada refresco no sería viable en servidores grandes.

## Servidores CS 1.6

Se configuran en `/config → Servidores CS 1.6` con nombre e `IP:puerto`.

- `/servidores` consulta cada server por el protocolo de Valve (A2S, UDP directo) y muestra estado, jugadores, mapa, latencia y ocupación. El staff puede publicar un panel que se actualiza solo cada 90 s.
- `/ip [servidor]` responde la IP lista para copiar; con filtro muestra mapa y jugadores de ahora.
- `/jugadores [servidor]` muestra quién está conectado, con puntaje y tiempo en línea.
- **Alertas:** avisa al staff cuando un server deja de responder o vuelve. Se pueden apagar desde el panel.

El monitoreo hace 2 intentos con timeout de 2,5 s antes de dar un server por caído, y los comandos usan su caché para responder al instante.

## Niveles y logros

| Comando | Qué hace |
| --- | --- |
| `/estadisticas [usuario]` | Perfil completo: rango, nivel, XP con barra, bonus, racha, puesto y próximos logros |
| `/logros [usuario]` | Progreso logro por logro, del más cercano al más lejano |
| `/rolnivel definir/quitar/lista` | Roles que se otorgan automáticamente al alcanzar un nivel (staff) |
| `/top [pagina]` | Ranking con podio, tu puesto y páginas |

XP por escribir (15-25, máximo 1 vez por minuto) con bonus acumulables: +1 % por día de racha (tope +35 %), **x2 los fines de semana** y +10 % de madrugada (00-06 h Argentina). 16 logros con recompensa de XP, rangos por nivel y roles automáticos. También hay **XP por voz**: 8 por minuto completo, hasta 200 por día, solo si estás acompañado, sin mutearte y fuera de los canales excluidos.

## Utilidades

| Comando | Qué hace |
| --- | --- |
| `/afk [motivo]` | Marca ausente; el bot avisa cuando te mencionan y la saca al volver a hablar |
| `/encuesta tema [opciones]` | Encuesta con reacciones (Sí/No o hasta 6 opciones) |
| `/embed titulo texto [color] [imagen] [canal]` | Anuncios con embeds (staff) |
| `/plantillas agregar/quitar/lista` | Razones rápidas que autocompletan `/warn`, `/ban`, `/kick` (staff) |
| `/frases configurar/agregar/publicar/lista/quitar` | Frase del día publicada a la hora elegida (staff) |

## Diversión y comunidad

| Comando | Qué hace |
| --- | --- |
| `/beso` `/abrazo` `/caricia` `/abofetear` `/morder` `/pellizco` `/chocar` `/guino` | Interacciones con GIF y contadores persistentes |
| `/meme` | Meme al azar de Reddit con botón *Otro* |
| `/8ball pregunta` | La bola 8 mágica con 20 veredictos |
| `/dado [caras]` | Dado de 1-6 hasta 100 caras |
| `/moneda` | Cara o ceca |

## Sorteos

`/sorteo crear premio:1 mes de VIP duracion:7d` publica un panel con **🎉 Participar** y **Salir**: la comunidad se anota con un clic.

- **Requisitos:** rol opcional, 1-10 ganadores y canal a elección.
- **Cierre automático:** al vencer quita los botones, anuncia a los ganadores y les manda un DM. Si el bot estuvo caído, cierra los vencidos al arrancar.
- **Gestión:** `/sorteo terminar id`, `/sorteo reroll id` (sin repetir ganadores si se puede), `/sorteo cancelar id` y `/sorteo lista`.
- **Estado persistente:** sobrevive reinicios y viaja con el respaldo de MariaDB. Un sorteo sin participantes queda desierto; nunca se inventa un ganador.

## Diagnóstico y calidad de la IA (staff)

| Comando | Qué hace |
| --- | --- |
| `/diag` | Diagnóstico operativo: qué está roto, qué hacer, salida a internet del host y estado de la base de conocimiento |
| `/buscar consulta` | Búsqueda web a mano: resultados con su fuente, cómo clasificaría el bot la pregunta y qué trajo la base (con su similitud) |
| `/faltantes ver/borrar/limpiar` | Preguntas que la IA no supo contestar, agrupadas y contadas: la lista de qué cargar en la base |
| `/latencias` | Latencia real por perfil, la causa de cada demora y las respuestas más lentas |

## Configuración (staff)

`/config` abre un **panel interactivo**: un menú con las secciones (Bienvenida, Mod-log, Logs, Avisos, Staff, Rol de silenciado, Chat con IA, Niveles, Frase del día, Anti-spam y anti-raid, Tickets, Desactivar) y selectores nativos para canales y roles. El mensaje de bienvenida se edita en una ventana emergente y cada desactivado pide confirmación. Todo se guarda al instante y el panel solo lo ve quien lo abre.

`/bienvenida test` muestra el embed **tal como lo reciben los nuevos** y avisa si el canal no existe, si falta permiso para escribir o si el rol de autorol se borró. Con `enviar:true` lo publica de verdad, aclarando que es una prueba y sin mencionar a nadie.

## Menú contextual

Click derecho sobre un usuario → **Aplicaciones**:

- **Ficha de niveles** — el mismo perfil que `/estadisticas`.
- **Ver warnings** — el historial de warns (staff).
