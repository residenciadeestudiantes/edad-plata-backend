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

function cargar(): EntradaDiccionario[] {
  if (!entradasCache) {
    const contenido = readFileSync(RUTA_DICCIONARIO, 'utf-8');
    entradasCache = JSON.parse(contenido) as EntradaDiccionario[];
    indicePorNombre = new Map();
    for (const entrada of entradasCache) {
      indicePorNombre.set(entrada.nombre.toLowerCase(), entrada);
    }
  }
  return entradasCache;
}

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Resuelve una remisión ("Ver: X") a su entrada canónica si existe.
function resolverRemision(entrada: EntradaDiccionario): EntradaDiccionario {
  if (entrada.es_remision && entrada.remite_a && indicePorNombre) {
    const canonica = indicePorNombre.get(entrada.remite_a.toLowerCase());
    if (canonica) return canonica;
  }
  return entrada;
}

// Busca entradas cuyo nombre contenga alguno de los candidatos extraídos
// de la pregunta del usuario (coincidencia de subcadena, insensible a
// mayúsculas y diacríticos). Puntúa cada coincidencia por la longitud del
// candidato que la produjo (un apellido común de una sola palabra, p. ej.
// "García", no debe ganarle a una coincidencia por el nombre completo,
// p. ej. "Federico García Lorca") y devuelve las `limite` mejores,
// resolviendo remisiones a su entrada canónica y descartando duplicados.
export function buscarEnDiccionario(candidatos: string[], limite = 4): EntradaDiccionario[] {
  const entradas = cargar();
  if (candidatos.length === 0) return [];

  const candidatosNorm = candidatos.map(normalizar);
  const vistos = new Set<string>();
  const puntuadas: { entrada: EntradaDiccionario; score: number }[] = [];

  for (const entrada of entradas) {
    const nombreNorm = normalizar(entrada.nombre);
    let score = 0;
    for (const c of candidatosNorm) {
      if (nombreNorm.includes(c) || c.includes(nombreNorm)) score = Math.max(score, c.length);
    }
    if (score === 0) continue;

    const resuelta = resolverRemision(entrada);
    if (vistos.has(resuelta.nombre)) continue;
    vistos.add(resuelta.nombre);
    puntuadas.push({ entrada: resuelta, score });
  }

  puntuadas.sort((a, b) => b.score - a.score);
  return puntuadas.slice(0, limite).map((p) => p.entrada);
}
