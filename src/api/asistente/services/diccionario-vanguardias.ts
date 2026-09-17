// Búsqueda por nombre sobre el diccionario biográfico de vanguardias
// (backend/diccionarios/entradas_finales.json, 2512 entradas: persona,
// lugar, publicacion, colectivo, movimiento, remision), parseado en la
// sesión 51 (ver scripts/diccionario_*.js). No vive en ninguna tabla de
// Strapi — solo una parte (persona/lugar/institucion/obra) se trasladó a
// `entidad-mencionada`, y `movimiento` no se trasladó en absoluto — así
// que para el asistente conviene leer el JSON completo directamente.
//
// Carga perezosa y cacheada en memoria, mismo espíritu de caché-prototipo
// que services/lemas.ts.

import { readFileSync } from 'fs';
import { join } from 'path';
import { mejoresCoincidencias, construirFrecuencias } from './coincidencias';

const RUTA_DICCIONARIO = join(process.cwd(), 'diccionarios', 'entradas_finales.json');

interface EntradaDiccionario {
  nombre: string;
  tipo: 'persona' | 'lugar' | 'publicacion' | 'colectivo' | 'movimiento' | 'remision';
  texto?: string;
  lugar_inicio?: string;
  anio_inicio?: number;
  lugar_fin?: string;
  anio_fin?: number;
  es_remision?: boolean;
  remite_a?: string;
  es_seudonimo?: boolean;
  nombre_real?: string;
}

let entradasCache: EntradaDiccionario[] | null = null;
let indicePorNombre: Map<string, EntradaDiccionario> | null = null;
let frecuenciasCache: Map<string, number> | null = null;

function cargar(): EntradaDiccionario[] {
  if (!entradasCache) {
    const contenido = readFileSync(RUTA_DICCIONARIO, 'utf-8');
    entradasCache = JSON.parse(contenido) as EntradaDiccionario[];
    indicePorNombre = new Map();
    for (const entrada of entradasCache) {
      indicePorNombre.set(entrada.nombre.toLowerCase(), entrada);
    }
    frecuenciasCache = construirFrecuencias(entradasCache, (e) => e.nombre);
  }
  return entradasCache;
}

// Resuelve una remisión ("Ver: X") a su entrada canónica si existe.
function resolverRemision(entrada: EntradaDiccionario): EntradaDiccionario {
  if (entrada.es_remision && entrada.remite_a && indicePorNombre) {
    const canonica = indicePorNombre.get(entrada.remite_a.toLowerCase());
    if (canonica) return canonica;
  }
  return entrada;
}

// Busca entradas cuyo nombre aparece completo en la pregunta del usuario
// (ver services/coincidencias.ts — por palabras, no por mayúsculas ni
// subcadena). Se piden más coincidencias de las necesarias porque resolver
// remisiones y descartar duplicados (p. ej. dos entradas "Índice" de
// ciudades distintas, o una remisión que apunta a una entrada ya
// encontrada) puede reducir el recuento por debajo de `limite`.
export function buscarEnDiccionario(pregunta: string, limite = 4): EntradaDiccionario[] {
  const entradas = cargar();
  const candidatas = mejoresCoincidencias(pregunta, entradas, (e) => e.nombre, limite * 3, frecuenciasCache!);

  const vistos = new Set<string>();
  const resultado: EntradaDiccionario[] = [];
  for (const entrada of candidatas) {
    const resuelta = resolverRemision(entrada);
    if (vistos.has(resuelta.nombre)) continue;
    vistos.add(resuelta.nombre);
    resultado.push(resuelta);
    if (resultado.length >= limite) break;
  }
  return resultado;
}
