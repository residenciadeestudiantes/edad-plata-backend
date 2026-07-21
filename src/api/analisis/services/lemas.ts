// Diccionario de lemas español (forma → lema), usado como mejora sobre el
// stemming de PorterStemmerEs en la búsqueda morfológica (ver
// `raizMorfologica` en controllers/analisis.ts): cuando una palabra del
// corpus está en el diccionario, se usa su lema real en vez de la raíz
// algorítmica, evitando fallos que el stemmer no resuelve (p. ej.
// luz/luces o sociedad/sociedades, que PorterStemmerEs reduce a raíces
// distintas). Si la palabra no está en el diccionario (nombres propios,
// vocabulario de época, ruido de OCR — inevitable en un corpus histórico),
// se cae al stemming actual como red de seguridad.
//
// Fuente del diccionario: michmech/lemmatization-lists (ODbL-1.0), ver
// data/lemmatization-es.txt.LICENSE. Carga perezosa y cacheada en memoria,
// mismo espíritu de caché-prototipo que bigramas.ts.

import { readFileSync } from 'fs';
import { join } from 'path';

const RUTA_DICCIONARIO = join(process.cwd(), 'data', 'lemmatization-es.txt');

let diccionarioCache: Map<string, string> | null = null;

function construirDiccionario(): Map<string, string> {
  const contenido = readFileSync(RUTA_DICCIONARIO, 'utf-8').replace(/^\uFEFF/, '');
  const diccionario = new Map<string, string>();

  for (const linea of contenido.split('\n')) {
    const [lemaRaw, formaRaw] = linea.split('\t');
    if (!lemaRaw || !formaRaw) continue;
    const lema = lemaRaw.trim().toLowerCase();
    const forma = formaRaw.trim().toLowerCase();
    diccionario.set(forma, lema);
    // El fichero solo lista formas flexionadas → lema, nunca el lema
    // apuntando a sí mismo; sin esto, buscar directamente por la forma
    // canónica (p. ej. "cantar") no encontraría coincidencia consigo misma
    // al compararla con "canto"/"cantaba" (que sí resuelven a "cantar").
    if (!diccionario.has(lema)) diccionario.set(lema, lema);
  }

  return diccionario;
}

export function obtenerLema(palabra: string): string | undefined {
  if (!diccionarioCache) {
    diccionarioCache = construirDiccionario();
  }
  return diccionarioCache.get(palabra.toLowerCase());
}
