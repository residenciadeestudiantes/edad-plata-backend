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

// Distancia de edición entre dos palabras ya normalizadas (Levenshtein +
// transposición de letras adyacentes contando como 1 solo cambio, no 2 —
// variante "optimal string alignment" de Damerau-Levenshtein). Sin la
// transposición, una errata tan común como "Lroca" por "Lorca" cuesta 2 y
// queda fuera del umbral de una palabra de 5 letras, y no se sugiere nada.
function distanciaEdicion(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + costo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

// Cuántas letras de diferencia se toleran como probable errata, según la
// longitud de la palabra — cuanto más corta, menos margen (una palabra de
// 4 letras con distancia 2 ya es prácticamente otra palabra).
function umbralErrata(longitud: number): number {
  if (longitud >= 8) return 2;
  if (longitud >= 4) return 1;
  return 0;
}

// Palabras con mayúscula inicial en el texto ORIGINAL (antes de
// normalizar) y de longitud ≥4: a diferencia de mejoresCoincidencias, que
// deliberadamente no depende de mayúsculas, esta red de seguridad sí las
// exige — es la única señal barata para distinguir "esto podría ser un
// nombre propio mal escrito" de una palabra común cualquiera. Sin este
// filtro, una pregunta sin ningún nombre propio (p. ej. buscar una frase
// literal: "...se han visto luces, puentes, gaviotas y barcazas...")
// encontraba por casualidad candidatos como "barcazas"→"Barradas" o
// "puentes"→"Puente" y sugería personas sin relación alguna con la
// pregunta (encontrado probando en producción).
function palabrasCapitalizadas(texto: string): string[] {
  return texto
    .replace(/[^\p{L}0-9]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => /^[A-ZÁÉÍÓÚÑÜ]/.test(w))
    .map(normalizarTexto)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// Ni sinónimo ni variante: candidatos a "quisiste decir" cuando la
// pregunta NO tuvo ninguna coincidencia exacta en ningún catálogo NI
// ningún artículo relevante (ver controllers/asistente.ts). No sustituye
// a mejoresCoincidencias — se usa solo como red de seguridad para
// sugerir, nunca para dar por buena una entrada con una errata como si
// fuera la que el usuario pidió: así se evita el mismo tipo de falso
// positivo que ya costó corregir dos veces en la búsqueda exacta (ver
// cabecera del archivo).
export function sugerenciasPorErrata<T>(
  pregunta: string,
  catalogo: T[],
  obtenerNombre: (item: T) => string,
  limite: number
): T[] {
  const palabrasPregunta = palabrasCapitalizadas(pregunta);
  if (palabrasPregunta.length === 0) return [];

  const candidatos: { item: T; dist: number }[] = [];
  for (const item of catalogo) {
    const palabrasNombre = palabrasSignificativas(obtenerNombre(item)).filter((w) => w.length >= 4);
    let mejorDist = Infinity;
    for (const pw of palabrasPregunta) {
      for (const nw of palabrasNombre) {
        if (Math.abs(pw.length - nw.length) > umbralErrata(Math.max(pw.length, nw.length))) continue;
        const d = distanciaEdicion(pw, nw);
        if (d > 0 && d <= umbralErrata(Math.max(pw.length, nw.length)) && d < mejorDist) mejorDist = d;
      }
    }
    if (mejorDist < Infinity) candidatos.push({ item, dist: mejorDist });
  }

  candidatos.sort((a, b) => a.dist - b.dist);
  return candidatos.slice(0, limite).map((c) => c.item);
}
