// Coincidencia de nombres propios entre la pregunta del usuario y un
// catálogo (autores, entidades mencionadas, diccionario de vanguardias),
// por PALABRAS COMPLETAS en vez de por subcadena o por detectar mayúsculas.
//
// Motivación (tres fallos reales encontrados probando en producción):
// 1. La heurística original solo consideraba nombre propio lo que el
//    usuario escribiera con mayúscula inicial. En un chat casi nadie
//    escribe así ("quien es adolfo centauro", "qué es índice"), así que
//    el asistente perdía sistemáticamente autores/entidades/diccionario
//    en preguntas escritas con normalidad.
// 2. La comparación por subcadena tenía sus propios falsos positivos: el
//    candidato "Qué" normalizado a "que" es subcadena de "marqués".
// 3. Exigir que coincidiera al menos una palabra del nombre (sin más)
//    reintroduce el mismo problema por otra vía: "que" es en sí misma una
//    palabra de longitud ≥3, y aparece suelta dentro de algunos títulos
//    largos ("... para que empiezan ...").
//
// La solución: normalizar sin acentos/mayúsculas, partir en palabras,
// descartar las palabras gramaticales del español (mismo listado ya usado
// para TF-IDF en análisis léxico, ../../analisis/services/stopwords) y
// comparar por PALABRA COMPLETA, nunca por subcadena — así "que" nunca
// coincide por accidente con una palabra distinta como "marques".
//
// Sobre cobertura completa vs. parcial: exigir que TODAS las palabras del
// nombre aparezcan en la pregunta evita el ruido de un nombre o apellido
// común usado solo ("Adolfo", "García", "Manuel" aparecen en decenas de
// fichas) — pero sería demasiado estricto para lo más habitual al
// referirse a alguien conocido: solo el apellido ("Lorca", "Dalí"). Por
// eso se acepta también una coincidencia parcial cuando al menos una de
// las palabras coincidentes es "distintiva": aparece en pocas fichas del
// propio catálogo (umbral configurable). Así "Dalí" solo (frecuencia baja
// en el catálogo) basta para encontrar "Dalí, Salvador", pero "Adolfo"
// solo (frecuencia alta) no basta para sacar cualquier ficha con ese
// nombre de pila.

import { STOPWORDS } from '../../analisis/services/stopwords';

const MIN_LONGITUD_PALABRA = 3;
const UMBRAL_PALABRA_DISTINTIVA = 3;

function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function palabrasSignificativas(texto: string): string[] {
  return normalizarTexto(texto)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= MIN_LONGITUD_PALABRA && !STOPWORDS.has(w));
}

// Cuenta en cuántas entradas del catálogo aparece cada palabra (de su
// nombre), para poder distinguir un nombre/apellido común de uno
// distintivo. Se calcula una vez por catálogo y se cachea junto a él.
export function construirFrecuencias<T>(catalogo: T[], obtenerNombre: (item: T) => string): Map<string, number> {
  const frecuencias = new Map<string, number>();
  for (const item of catalogo) {
    const palabras = new Set(palabrasSignificativas(obtenerNombre(item)));
    for (const p of palabras) frecuencias.set(p, (frecuencias.get(p) ?? 0) + 1);
  }
  return frecuencias;
}

// Busca, en un catálogo ya cargado en memoria, las entradas cuyo nombre
// coincide con la pregunta por cobertura completa, o parcial si incluye
// al menos una palabra distintiva (ver cabecera del archivo). Puntúa por
// especificidad (más palabras y más largas primero) y devuelve como
// máximo `limite` entradas.
export function mejoresCoincidencias<T>(
  pregunta: string,
  catalogo: T[],
  obtenerNombre: (item: T) => string,
  limite: number,
  frecuencias?: Map<string, number>
): T[] {
  const palabrasPregunta = new Set(palabrasSignificativas(pregunta));
  if (palabrasPregunta.size === 0) return [];

  const frec = frecuencias ?? construirFrecuencias(catalogo, obtenerNombre);
  const puntuadas: { item: T; score: number }[] = [];

  for (const item of catalogo) {
    const palabrasNombre = palabrasSignificativas(obtenerNombre(item));
    if (palabrasNombre.length === 0) continue;

    const coincidentes = palabrasNombre.filter((w) => palabrasPregunta.has(w));
    if (coincidentes.length === 0) continue;

    const coberturaCompleta = coincidentes.length === palabrasNombre.length;
    const tieneDistintiva = coincidentes.some((w) => (frec.get(w) ?? 0) <= UMBRAL_PALABRA_DISTINTIVA);
    if (!coberturaCompleta && !tieneDistintiva) continue;

    const score = coincidentes.length * 100 + coincidentes.reduce((acc, w) => acc + w.length, 0);
    puntuadas.push({ item, score });
  }

  puntuadas.sort((a, b) => b.score - a.score);
  return puntuadas.slice(0, limite).map((p) => p.item);
}
