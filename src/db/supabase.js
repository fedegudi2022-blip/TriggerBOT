// Cliente REST de Supabase para TriggerBOT — SIN SDK.
// ¿Por qué no @supabase/supabase-js? La versión nueva exige Node 22+ (WebSocket
// nativo) y el host corre Node 19: crasheaba el bot al arrancar. La API REST de
// Supabase (PostgREST) cubre exactamente lo que necesitamos: upsert, select y
// delete sobre dos tablas, con fetch nativo (Node 18+) y cero dependencias.
//
// Diseño: el bot SIEMPRE escribe primero en su caché local (data/*.json, como
// siempre), y esta capa sube cada cambio a Supabase con debounce. Si Supabase
// falla o no está configurado, el bot funciona exactamente igual que antes.

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_KEY || '';

const configurada = Boolean(URL_BASE && KEY);
const TIMEOUT_MS = 10_000;

// ---------- Estado de conexión (lo muestra /status) ----------
const estado = {
  configurada,
  conectado: false,
  ultimoError: null,
  subidasOk: 0,
  subidasFallidas: 0,
  ultimaSync: null, // Date de la última subida exitosa
};

function anotarFallo(error) {
  estado.ultimoError = error?.message || String(error);
  estado.conectado = false;
}

// ---------- Capa HTTP ----------
async function pedir(url, opciones = {}) {
  const resp = await fetch(url, {
    method: opciones.method || 'GET',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
    },
    body: opciones.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const texto = await resp.text();
  let datos = null;
  if (texto) {
    try {
      datos = JSON.parse(texto);
    } catch {
      datos = texto;
    }
  }
  if (!resp.ok) {
    const mensaje = datos?.message || datos?.error_description || datos?.error || `HTTP ${resp.status}`;
    throw new Error(String(mensaje));
  }
  return datos;
}

// ---------- Operaciones ----------

// Sube (inserta o actualiza) un almacén completo de un servidor.
async function subir(clave, guildId, almacen, datos) {
  if (!configurada) return false;
  try {
    await pedir(`${URL_BASE}/rest/v1/bot_data?on_conflict=clave`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([
        {
          clave,
          guild_id: guildId,
          almacen,
          datos,
          actualizado_en: new Date().toISOString(),
          version: Date.now(),
        },
      ]),
    });
    estado.subidasOk += 1;
    estado.conectado = true;
    estado.ultimoError = null;
    estado.ultimaSync = new Date();
    return true;
  } catch (error) {
    estado.subidasFallidas += 1;
    anotarFallo(error);
    console.error('[TriggerBOT] Supabase: fallo al subir', clave, error.message);
    return false;
  }
}

// Descarga una fila por su clave. Devuelve { datos, version } o null.
async function descargar(clave) {
  if (!configurada) return null;
  try {
    const filas = await pedir(
      `${URL_BASE}/rest/v1/bot_data?select=datos,version&clave=eq.${encodeURIComponent(clave)}&limit=1`
    );
    estado.conectado = true;
    return filas?.[0] ?? null;
  } catch (error) {
    anotarFallo(error);
    console.error('[TriggerBOT] Supabase: fallo al descargar', clave, error.message);
    return null;
  }
}

// Lista filas de bot_data. Si `guildIds` es un array no vacío, filtra por esos
// servidores; si es null trae todo. Lanza el error (el que llama decide).
async function listar(guildIds = null) {
  if (!configurada) return [];
  let url = `${URL_BASE}/rest/v1/bot_data?select=clave,guild_id,almacen,datos,version`;
  if (Array.isArray(guildIds) && guildIds.length > 0) {
    const lista = guildIds.map((g) => `"${g}"`).join(',');
    url += `&guild_id=in.${encodeURIComponent(`(${lista})`)}`;
  }
  const filas = await pedir(url);
  estado.conectado = true;
  return filas ?? [];
}

// Elimina una fila por clave.
async function eliminar(clave) {
  if (!configurada) return false;
  try {
    await pedir(`${URL_BASE}/rest/v1/bot_data?clave=eq.${encodeURIComponent(clave)}`, { method: 'DELETE' });
    return true;
  } catch (error) {
    anotarFallo(error);
    console.error('[TriggerBOT] Supabase: fallo al eliminar', clave, error.message);
    return false;
  }
}

// Ping real a la base (usado por /status para saber si responde).
async function ping() {
  if (!configurada) return false;
  try {
    await pedir(`${URL_BASE}/rest/v1/bot_stats?select=clave&limit=1`);
    estado.conectado = true;
    estado.ultimoError = null;
    return true;
  } catch (error) {
    anotarFallo(error);
    return false;
  }
}

module.exports = { estado, configurada, subir, descargar, listar, eliminar, ping };
