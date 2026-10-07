# Base de conocimiento de la IA

Los archivos `.md` de esta carpeta son lo que el bot **usa como verdad** para los
temas de la comunidad cuando alguien le pregunta algo por chat (mencionándolo). La IA
lee estos archivos, busca los fragmentos más parecidos a la pregunta y responde **solo
con eso**: si la pregunta es de la comunidad y el dato exacto no está acá, contesta con
lo que sí está cargado de ese tema, aclara en una frase qué dato le falta y deriva al
staff (nunca devuelve una negativa seca). Nunca inventa una regla, una sanción ni un
horario de acá.

> Esto vale para la comunidad. Para preguntas de cultura general (deportes, historia,
famosos, ciencia, precios, noticias) el bot responde con su propio conocimiento y con
una búsqueda web real (ver `utils/web.js`): ahí no hace falta cargar nada acá.

> Este `README.md` **no** se usa como conocimiento (se ignora a propósito): las
> instrucciones de carga viven acá, no en las respuestas.

## Cómo se lee cada archivo

- Cada `## Título` abre una **sección** independiente; el texto hasta el próximo
  `##` es el contenido de esa sección.
- El buscador puntúa secciones por coincidencia de palabras (con raíces: `banear`
  encuentra `baneo`) y, si están los vectores, también por **significado**: así encuentra
  el tema aunque la pregunta use otras palabras («no me llegan los mensajes» encuentra
  *Rol Silenciado*). Devuelve las 3 mejores, hasta 1.200 caracteres cada una. La parte
  semántica es opcional (usa la clave de Gemini): sin clave, o con `KB_SEMANTICO=off`, el
  buscador sigue funcionando por palabras. `/diag` dice si está activa y `/buscar`
  (staff) muestra qué trajo cada señal con su similitud.
- **Solo entran al prompt cuando corresponden**: en una pregunta de la comunidad
  siempre, y en una de cultura general únicamente si la coincidencia tocó alguna palabra
  **con contenido del título** ("publicidad" entra por *Norma 3 — Spam, flood y
  publicidad*; "cuántos" no cuenta, es parte del armado de la pregunta). Salvo que la
  pregunta nombre una **entidad de afuera** (YouTube, Minecraft, Elden Ring…): ahí el
  tema es del mundo aunque el título de una sección tenga esa palabra. Por eso los
  títulos deben describir el tema con las palabras que usaría la gente: es lo que hace
  que la sección se encuentre y se inyecte donde tiene que aparecer.
- Los archivos que empiezan con `_` o se llaman `README.md` se ignoran.
- Los cambios en estos archivos se recargan solos como máximo **1 minuto** después
  de guardarlos: no hay que reiniciar el bot.
- Cuando el bot **no encuentra** la respuesta, la pregunta no se pierde: queda registrada
  y el staff la ve con `/faltantes` (los más preguntados primero, con quién y cuándo).
  Cargar la sección acá y borrar el tema de esa lista con `/faltantes borrar` es el ciclo
  completo: la lista es exactamente lo que falta en esta carpeta.

## Reglas de escritura

1. **Datos concretos, sin adornos.** "El silencio por 3 advertencias dura 1 hora"
   es útil; "acá te explicamos nuestra filosofía de moderación" no lo es.
2. **Una idea por sección**, con el título ya describiendo el tema
   (`## Cuánto XP necesito para subir de nivel`), porque el título también puntúa.
3. **Escribí el nombre del tema tal como lo preguntaría la gente**: "cómo entro al
   servidor", "cómo funciona el mute", "puedo publicar mi discord".
4. **Nunca inventes**: si no sabés el dato real, dejá la sección marcada como
   pendiente. El bot está instruido para decir "no tengo esa info" cuando no la
   encuentra, y eso es mejor que una respuesta falsa.

## Archivos actuales

| Archivo | Qué cubre |
|---|---|
| `comunidad.md` | Qué es TriGGer.Arena, links oficiales, redes, web |
| `conectar.md` | Cómo entrar a los servidores CS 1.6, IPs, filtros |
| `niveles.md` | XP, niveles, racha, bonus, rangos y logros |
| `moderacion.md` | Warn, timeout, mute, clear, lockdown y sanciones automáticas |
| `soporte.md` | Tickets, cómo pedir ayuda y reportar a alguien |
| `reglas.md` | Normativas oficiales: las 12 normas de TriGGer.Arena |
| `bot.md` | Qué es el bot, cómo hablarle y qué comandos tiene |
