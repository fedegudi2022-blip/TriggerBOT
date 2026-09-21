// Cliente de Supabase para TriggerBOT.
// Diseño: el bot SIEMPRE escribe primero en su caché local (data/*.json, como siempre),
// y esta capa sube cada cambio a Supabase (respaldo maestro) con debounce.
// Al arrancar, se restaura la copia más nueva entre local y nube.
//
// Si no hay SUPABASE_URL y SUPABASE_KEY configuradas, todo se desactiva solo:
// el bot funciona exactamente igual que antes, sin tocar la red.

const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_KEY || '';

const configurada = Boolean(URL && KEY);

const supabase = configurada ? createClient(URL, KEY, { auth: { persistSession: false } }) : null;

// ---------- Estado de conexión (lo muestra /status) ----------
const estado = {
  configurada,
  conectado: false,
  ultimoError: null,
  subidasOk: 0,
  subidasFallidas: 0,
  ultimaSync: null, // Date de la última subida exitosa
};

// ---------- Operaciones básicas ----------

// Sube (inserta o actualiza) un almacén completo de un servidor.
async function subir(clave, guildId, almacen, datos) {
  if (!supabase) return false;
  const { error } = await supabase.from('bot_data').upsert(
    {
      clave,
      guild_id: guildId,
      almacen,
      datos,
      actualizado_en: new Date().toISOString(),
      version: Date.now(),
    },
    { onConflict: 'clave' }
  );
  if (error) {
    estado.ultimoError = error.message;
    estado.subidasFallidas += 1;
    console.error('[TriggerBOT] Supabase: fallo al subir', clave, error.message);
    return false;
  }
  estado.subidasOk += 1;
  estado.ultimaSync = new Date();
  return true;
}

// Descarga un almacén completo por su clave. Devuelve { datos, version } o null.
async function descargar(clave) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('bot_data').select('datos, version').eq('clave', clave).maybeSingle();
  if (error) {
    estado.ultimoError = error.message;
    console.error('[TriggerBOT] Supabase: fallo al descargar', clave, error.message);
    return null;
  }
  return data ?? null;
}

// Ping real a la base (usado por /status para saber si responde).
async function ping() {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('bot_stats').select('clave').limit(1);
    estado.conectado = !error;
    if (error) estado.ultimoError = error.message;
    return estado.conectado;
  } catch (error) {
    estado.conectado = false;
    estado.ultimoError = error.message;
    return false;
  }
}

module.exports = { supabase, estado, subir, descargar, ping, configurada };
