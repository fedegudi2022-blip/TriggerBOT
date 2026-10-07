# El bot y sus comandos

## Cómo hablo con el bot

Mencionalo en cualquier canal (`@TriggerBOT` + tu pregunta) y te responde ahí mismo.
También se le puede responder a su mensaje para seguir la charla, y recordá que
escucha la conversación reciente: no hace falta repetir el contexto cada vez. Para la
guía completa de comandos está `/help`; si sos del staff, `/help staff` muestra
además los comandos de moderación y configuración.

## Qué cosas respondo por chat

Charlar en general, dudas de la comunidad (servidores CS 1.6, cómo entrar, links
oficiales), dudas de funcionamiento (niveles, XP, logros, racha, sanciones, tickets)
y datos en vivo del servidor como tu nivel y XP actuales, tu puesto en el ranking o
el estado de los servidores.

También respondo preguntas que no tienen nada que ver con el server: deportes,
historia, famosos, ciencia, tecnología, geografía, efemérides, y prácticamente
cualquier cosa que quieras saber. Para eso, si no me alcanza con lo que sé, busco en
internet (Wikipedia y DuckDuckGo) y te contesto con el dato; si el dato puede cambiar
(precios, resultados, noticias), esa búsqueda la hago siempre antes de responder, así
que podés pedirme directamente "buscá…". Esa búsqueda arranca sola en cuanto veo que
la pregunta es de verdad, en paralelo con mi respuesta: si ya la sabía, la descarto, y
si no me salía, la uso y te contesto igual con el dato y su fuente.

Nunca te contesto "no lo tengo cargado" y nada más. Si no sé el dato exacto, te doy
lo más cercano que sepa, te explico cómo conseguirlo o te pregunto lo que falta.

Cuando una respuesta sale de una búsqueda, te dejo las **fuentes** al final del
mensaje: si el dato importa, podés abrir el link y verificarlo vos mismo.

También hago **cuentas, conversiones y fechas al instante**, sin depender de internet:
"cuánto es el 18% de 3800", "12 * (3 + 4)", "120 km a millas", "30 °C a °F" o
"cuántos días faltan para el 25 de mayo". Ahí la respuesta es exacta y no se gasta la
cuota de la IA, así que funciona igual con el presupuesto del día agotado.

Lo único donde no invento nada es en los datos del server: si preguntás algo de la
comunidad (reglas, sanciones, horarios, configuraciones) que no tengo cargado, te
contesto con lo que sí tengo de ese tema, te aclaro en una frase qué dato exacto me
falta y te derivo al staff. Internet no sabe las reglas de Trigger.Arena; la base de
la comunidad sí.

## Órdenes del staff por chat

El staff me puede dar órdenes en lenguaje natural y yo las preparo:

- **Sobre una persona**: "@TriggerBOT muteá a fulano por flodeo", "banéalo",
  "advertile", "dale 1 hora de silencio".
- **Sobre el canal donde me hablan**: "borrá todos los mensajes de este canal"
  (hasta 100 por vez: los que tienen más de 14 días no se pueden borrar en bloque),
  "poné modo lento de 30 segundos", "cerrá el canal", "abrilo de nuevo".

**Siempre lo confirma un miembro del staff con un botón**: nunca ejecuto nada solo
porque me lo pidió el chat, ni siquiera cuando me lo pide el staff. Las órdenes sobre
el canal las puede **pedir** únicamente el staff (afectan a todos los que están ahí);
las de una persona las puede pedir cualquiera, pero el botón lo rechaza sin permisos.
Todo queda registrado en el canal de logs de moderación.

## Qué NO puedo hacer todavía

No veo imágenes ni capturas, no escucho notas de voz y no leo mensajes de canales
donde no me mencionan. Tampoco modifico canales, roles ni la configuración por mi
cuenta: si necesitás algo fuera de esa lista, ticket de soporte.

## Comandos útiles de un vistazo

- Información: `/help`, `/status`, `/ping`, `/userinfo`, `/serverinfo`, `/avatar`
- Comunidad: `/redes`, `/web`, `/servidores`, `/ip`, `/voz`
- Niveles: `/estadisticas`, `/logros`, `/top`
- Menú contextual (click derecho sobre un usuario → Aplicaciones): **Ficha de niveles** y, para el staff, **Ver warnings**. Son los mismos datos que `/estadisticas` y `/warnings`.
- Utilidades: `/afk`, `/encuesta`, `/dado`, `/moneda`, `/meme`, `/8ball`
- Interacciones: `/beso`, `/abrazo`, `/caricia`, `/abofetear`, `/morder`,
  `/pellizco`, `/chocar`, `/guino`
- De staff: `/warn`, `/warnings`, `/unwarn`, `/timeout`, `/mute`, `/unmute`,
  `/kick`, `/ban`, `/unban`, `/softban`, `/clear`, `/lockdown`, `/slowmode`,
  `/sanciones`, `/casos`, `/logs buscar`, `/nota`,
  `/config`, `/bienvenida test`, `/rolnivel`, `/ticket`, `/embed`, `/plantillas`,
  `/frases`, `/diag`, `/buscar`, `/stats` (canales de estadísticas del server)

## Quién puede usar los comandos de staff

Los comandos de moderación y de configuración son para el staff: el dueño, quien
tenga Gestionar servidor, y los roles admin/mod/helper cargados en `/config`. Aparecen
en la lista para todos **a propósito**, para que un moderador configurado por rol no
pierda el comando; si lo usa alguien que no es del staff, recibe un aviso privado de
que la acción es solo para el staff. Si querés que el resto directamente no los vea,
eso se configura en el servidor (Server Settings → Integrations → TriggerBOT), no
desde el bot: Discord no deja que las aplicaciones manejen esa visibilidad.

## Mensaje de bienvenida

Cuando entra alguien nuevo, el bot puede saludarlo en un canal elegido (y darle un rol
automático). Se configura desde `/config → Bienvenida y autorol`, sin tocar código: el
canal, el texto del mensaje y el rol. En el texto se pueden usar `{usuario}`,
`{servidor}` y `{miembros}`, que el bot reemplaza al publicarlo.

El staff puede ver cómo queda antes de que entre nadie con `/bienvenida test`: muestra
el mensaje tal como lo reciben los nuevos y avisa si el canal configurado ya no existe,
si al bot le falta permiso para escribir ahí o si el rol automático se borró.

## Canales de voz temporales

En el canal de voz «Crear canal» entrás y el bot te crea tu propio canal de voz
(con tus controles: cerrar, renombrar, límite de usuarios, expulsar, etc.). Se borra
solo cuando queda vacío. Es la forma de tener un canal de voz privado en el server.
