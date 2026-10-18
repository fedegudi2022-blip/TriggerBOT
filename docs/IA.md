# Chat con IA

El bot conversa cuando lo mencionás (`@TriggerBOT …`). Es **opcional**: con una clave configurada usa proveedores externos; sin ninguna, responde con su repertorio local y nunca se queda mudo.

## Cómo responde

- **Memoria corta por usuario:** los últimos 6 turnos, se olvida a los 10 minutos.
- **Contexto real, no de memoria:** antes de cada respuesta el prompt se arma con tu ficha (nivel, XP, puesto, racha, logros y warns), si estás silenciado, el estado en vivo de los servidores CS 1.6, la configuración activa (tickets, voz, anti-spam), el catálogo real de comandos y los fragmentos más parecidos de la base de conocimiento.
- **Tres perfiles:** *charla* (corto, con gracia), *consulta* (preciso, con datos) y *profundo* (explicaciones, comparaciones, código: hasta 1.400 tokens). La temperatura baja en consultas es lo que evita que invente.
- **Respuestas largas:** si el modelo se queda sin tokens, reintenta con más margen; al publicar, el texto se parte en varios mensajes sin cortar palabras.
- **Indicador de escribiendo:** se refresca durante todo el turno, incluso cuando la respuesta tarda por búsqueda web o reintentos.

## Base de conocimiento

Los `.md` de [`docs/conocimiento/`](conocimiento/README.md) son la **verdad** para los temas de la comunidad (reglas, soporte, niveles, comunidad). El bot busca por palabras (BM25, con raíces: `banear` encuentra `baneo`) y, si hay vectores, también por **significado**: así encuentra el tema aunque la pregunta use otras palabras («no me llegan los mensajes» → *Rol Silenciado*).

- Si el dato exacto no está, **no deja la pregunta sin responder**: contesta con lo que sí está cargado, aclara en una frase qué falta y deriva al staff.
- Nunca inventa una regla, una sanción ni un horario. Para cargar algo nuevo alcanza con editar o agregar un `.md`: se recarga solo en menos de un minuto, sin reiniciar.
- La búsqueda semántica es opcional (`KB_SEMANTICO`, cachea vectores en `data/embeddings.json`) y **no gasta** el presupuesto diario de IA.

## Preguntas del mundo real

La precisión estricta vale para los datos del servidor, no para todo. Cultura general, deportes, historia, precios y noticias se responden con el modelo y, cuando hace falta, con búsqueda web real y sin claves de API:

- **Fuentes:** Wikipedia en español (e inglés si no hay nada), DuckDuckGo Instant Answer y el HTML público de DDG Lite. Datos vivos: cotización del dólar/euro (Bluelytics) y clima (Open-Meteo).
- **Investiga en rondas:** si la primera no trae nada, reintenta en inglés y después con la consulta reducida a palabras con contenido (`anos messi`).
- **Comunidad o mundo lo decide la pregunta**, no una lista fija: mandan las anclas del server, el contexto («este server») y las entidades del mundo (YouTube, Elden Ring…). La base de la comunidad **no** viaja en preguntas generales.
- **Cuándo busca:** nunca en charla social; sí para cualquier pregunta de cultura general (aunque no lleve signo de pregunta) y para preguntas de la comunidad que la base no cubre. Si el dato cambia con el tiempo, busca antes de responder; si no, arranca en paralelo y descarta los resultados si el modelo ya sabía.
- **Nunca se queda en «no lo tengo cargado»:** si el modelo se niega, le hace contestar de nuevo con los resultados a la vista; si vuelve a negarse, entrega el dato crudo con su fuente.
- **Cita las fuentes:** cierra con `🔎 Fuentes:` y hasta 3 links, sin repetir los que ya nombró el modelo.
- **Cálculos exactos:** `18% de 3800`, `12 * (3 + 4)`, `120 km a millas`, `30 °C a °F` o días hasta una fecha se resuelven sin IA, al instante y aunque la cuota esté agotada.
- **Caché:** las preguntas generales repetidas se contestan de una caché por usuario (10 min); las de la comunidad nunca se cachean porque dependen de datos vivos.

Los límites están acotados: 30 búsquedas por minuto, timeouts de 3,5 s por fuente y 6 s totales, y dos pedidos iguales simultáneos salen a internet una sola vez.

## Presupuesto diario

`IA_LIMITE_DIARIO` (300 por defecto) es el tope de respuestas por día. Al agotarse, el bot deja de llamar al modelo **y** de buscar hasta la medianoche (hora de Argentina): contesta con su repertorio local y la vigilancia avisa al staff una vez por jornada. El contador se respalda en `bot_stats`, así un reinicio no regala cupo. `/status` y `/diag` muestran `usadas/límite`.

## Acciones de moderación por chat

El staff puede pedirlas en lenguaje natural y la IA prepara la acción, siempre con confirmación por botones:

- **Sobre una persona:** «baneá a @fulano por flodeo», «mutealo», «dale 1 hora de silencio».
- **Sobre el canal:** «borrá todos los mensajes de este canal» (hasta 100; los de más de 14 días no se pueden borrar en bloque), «modo lento de 30 segundos», «cerrá el canal».

Solo el staff puede apretar **Ejecutar**, y para cada acción vale el mismo permiso que exige el comando equivalente. Se registra en el mod-log, tiene 20 s de cooldown por usuario y expira a los 5 minutos.

## Proveedores y velocidad

Los proveedores viven en una tabla: sumar uno es agregar su clave. Orden de respaldo:

1. **Groq** (principal): modelos GPT-OSS, ~0,3-0,8 s.
2. **Cerebras**: el más rápido, buen respaldo cuando Groq se queda sin cuota.
3. **Gemini**: respaldo de calidad; descarta solo los modelos retirados.
4. **OpenRouter**: solo modelos `:free`, nunca gasta en uno de pago.
5. **Mistral**: último respaldo antes del repertorio local.

Optimizaciones:

- **Hedged request:** si el preferido no contestó en 1,4 s, el respaldo sale en paralelo y gana el primero. Cuando Groq va rápido no cuesta ninguna llamada extra.
- **Memoria de fallos:** un modelo retirado se descarta por horas y una clave inválida aparta al proveedor según el error. Un `401`, `402`, `403`, `429` o `5xx` aparta el proveedor **entero** (un 402 de facturación lo deja fuera 6 h): no tiene sentido probar otro modelo del mismo proveedor cuando el problema es la cuenta. Los cuerpos de error se resumen en una línea para que un 503 no ocupe cinco renglones del log.
- **Prueba al arrancar:** el modelo elegido se prueba con una petición mínima antes del primer mensaje.
- **Enrutado por complejidad:** los mensajes sociales cortos van al modelo chico; el grande queda para preguntas que requieren pensar.
- **Precalentamiento:** la lista de modelos se consulta al arrancar, no en el primer mensaje.
- **Respuestas instantáneas (0 ms):** identidad, links oficiales y saludos canónicos no llaman a la IA.

## Activación

Alcanza **una** clave (más claves = más respaldo). Se configuran en Wispbyte (Startup → Variables) o en `.env`:

| Variable | Dónde conseguirla |
| --- | --- |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) (solo `:free`) |
| `MISTRAL_API_KEY` | [console.mistral.ai](https://console.mistral.ai) |

`GEMINI_MODEL` / `GROQ_MODEL` (y equivalentes) permiten fijar un modelo; por defecto el bot detecta los mejores disponibles. `/status` muestra qué modelo usa cada IA, latencias, errores y pausas.

## Lo que falta se convierte en trabajo

Cuando la respuesta final queda en negativa, la pregunta se registra en `data/faltantes.json` (con respaldo en la base), agrupada por tema y contada. `/faltantes` es esa lista: cargás la sección en `docs/conocimiento/`, el bot la recarga solo y el tema se borra con `/faltantes borrar`.
