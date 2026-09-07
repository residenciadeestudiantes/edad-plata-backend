#!/usr/bin/env node
// Prueba piloto de entity linking: para 2-3 artículos concretos, extrae
// menciones candidatas con gpt-4o-mini y las enlaza contra el diccionario
// de vanguardias ya categorizado (backend/diccionarios/entradas_finales.json).
//
// No escribe nada en Strapi: es solo para ver qué tal enlaza, antes de
// decidir si merece la pena construir el pipeline completo sobre el corpus.
//
// Uso:
//   OPENAI_API_KEY=... node scripts/prueba_entity_linking.js

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = path.join(__dirname, '..', 'diccionarios');
const STRAPI_URL = process.env.STRAPI_URL || 'https://cmsedp.testresidencia.com';

const args = process.argv.slice(2);
const slugsFileArg = args.find((a) => a.startsWith('--slugs-file='));
const outArg = args.find((a) => a.startsWith('--out='));
const SLUGS = slugsFileArg
  ? JSON.parse(fs.readFileSync(slugsFileArg.split('=')[1], 'utf8'))
  : ['epistolario-2397', 'primer-amor-y-gongora-en-el-dancing', 'cultismo'];
const OUT_PATH = outArg ? outArg.split('=')[1] : null;

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'don', 'dona', 'o', 'u', 'e']);

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeForMatch(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

function tokensSignificativos(clave) {
  return clave.split(' ').filter((w) => w.length >= 4);
}

// --- 1. Gazetteer: resuelve remisiones y seudónimos como alias de su entrada canónica ---
// Alcance del piloto: Personas, Obras, Ciudades e Instituciones. Se deja
// fuera "movimiento" (solo 7 entradas: Dadaísmo, Cubismo...) por ahora.
const TIPOS_EN_ALCANCE = new Set(['persona', 'publicacion', 'lugar', 'colectivo']);

function construirGazetteer() {
  const finales = JSON.parse(fs.readFileSync(path.join(DIR, 'entradas_finales.json'), 'utf8'));
  const canonicas = finales.filter((e) => TIPOS_EN_ALCANCE.has(e.tipo));
  const remisiones = finales.filter((e) => e.tipo === 'remision');

  const indiceExacto = new Map(); // claveNormalizada -> entrada (o null si ambigua)
  // Cómo se llegó a esa clave: nombre_completo | alias_seudonimo | remision.
  // Una remisión no siempre es la misma identidad (p. ej. "Roland-Manuel.
  // Ver: Falla, Manuel de" son personas distintas, relacionadas pero no la
  // misma), así que necesitamos poder tratarla con menos confianza que un
  // nombre completo o un alias de seudónimo (que sí son la misma persona).
  const origenExacto = new Map();
  const registrar = (clave, entrada, origen) => {
    if (!clave) return;
    if (indiceExacto.has(clave) && indiceExacto.get(clave) !== entrada) indiceExacto.set(clave, null);
    else {
      indiceExacto.set(clave, entrada);
      if (origen && !origenExacto.has(clave)) origenExacto.set(clave, origen);
    }
  };

  // Primera pasada: solo el nombre propio de cada entrada. Así, si existe
  // una ficha biográfica completa para alguien (p. ej. "Gómez de la Serna,
  // Ramón"), queda indexada por derecho propio antes de procesar alias.
  for (const e of canonicas) {
    registrar(normalizeForMatch(e.nombre), e, 'nombre_completo');
  }

  // Segunda pasada: alias de seudónimo (nombre_real). Un mismo autor puede
  // tener varias fichas de seudónimo distintas (p. ej. "Ramón" y "Tristán",
  // ambas "seudónimo de Ramón Gómez de la Serna") que sin esto competirían
  // como si fueran personas distintas y se anularían entre sí como
  // ambiguas. Si ya existe una ficha biográfica separada con ese nombre
  // real, la usamos como destino canónico y reapuntamos también la clave
  // del propio seudónimo hacia ella (evitando el chequeo de colisión de
  // `registrar`, porque aquí la fusión es intencional, no una colisión).
  for (const e of canonicas) {
    if (!e.nombre_real) continue;
    const claveReal = normalizeForMatch(e.nombre_real);
    const clavePropia = normalizeForMatch(e.nombre);
    const existente = indiceExacto.get(claveReal);
    if (existente && existente !== e) {
      indiceExacto.set(clavePropia, existente);
      origenExacto.set(clavePropia, 'alias_seudonimo');
    } else if (!indiceExacto.has(claveReal)) {
      registrar(claveReal, e, 'alias_seudonimo');
    }
  }

  let remisionesResueltas = 0;
  for (const r of remisiones) {
    const destino = indiceExacto.get(normalizeForMatch(r.remite_a));
    if (destino) {
      registrar(normalizeForMatch(r.nombre), destino, 'remision');
      remisionesResueltas++;
    }
  }

  // Índice secundario por "apellido"/token distintivo, para matchear
  // menciones que en el texto solo dan el apellido (lo habitual en prosa
  // tras la primera aparición completa del nombre).
  const indicePorToken = new Map(); // token -> Set<entrada>
  for (const [clave, entrada] of indiceExacto) {
    if (!entrada) continue;
    for (const token of tokensSignificativos(clave)) {
      if (!indicePorToken.has(token)) indicePorToken.set(token, new Set());
      indicePorToken.get(token).add(entrada);
    }
  }

  // Un token muy repetido en el diccionario (nombres de pila frecuentes
  // como "José" o "Paul", pero también apellidos comunes como "García") no
  // es una señal fiable para matchear por apellido: "Paul Hazard" acabó
  // "matcheando" contra Paul Dermée/Eluard/Morand/Valéry solo por compartir
  // "Paul", ninguno de ellos comparte el apellido real. Se descarta ese
  // token del índice de fallback en vez de generar candidatos de baja
  // confianza.
  const UMBRAL_TOKEN_COMUN = 4;
  for (const [token, entradas] of indicePorToken) {
    if (entradas.size > UMBRAL_TOKEN_COMUN) indicePorToken.delete(token);
  }

  console.log(`Gazetteer: ${canonicas.length} entradas canónicas, ${remisionesResueltas}/${remisiones.length} remisiones resueltas como alias.`);
  return { indiceExacto, origenExacto, indicePorToken };
}

function buscarEnGazetteer(mencion, gazetteer) {
  const clave = normalizeForMatch(mencion);
  if (!clave) return { estado: 'sin_clave' };

  if (gazetteer.indiceExacto.has(clave)) {
    const entrada = gazetteer.indiceExacto.get(clave);
    return entrada
      ? { estado: 'exacto', entrada, origen: gazetteer.origenExacto.get(clave) }
      : { estado: 'ambiguo_exacto' };
  }

  const tokens = tokensSignificativos(clave);
  const candidatos = new Set();
  for (const t of tokens) {
    for (const e of gazetteer.indicePorToken.get(t) || []) candidatos.add(e);
  }
  if (candidatos.size === 1) return { estado: 'por_apellido', entrada: [...candidatos][0] };
  if (candidatos.size > 1) return { estado: 'ambiguo_apellido', candidatos: [...candidatos] };
  return { estado: 'sin_match' };
}

// --- 2. Extracción de menciones candidatas con LLM ---
const PROMPT = `Extrae del siguiente artículo de una revista cultural española (1898-1936) todas las menciones a ENTIDADES REALES Y VERIFICABLES de estos tipos:
- persona: escritores, artistas, y otras personas reales.
- publicacion: obras reales — revistas, periódicos, libros.
- lugar: ciudades, provincias o regiones reales.
- colectivo: instituciones, asociaciones, grupos o exposiciones colectivas reales.

No incluyas movimientos o corrientes artísticas (dadaísmo, surrealismo...), personajes de ficción, dioses/figuras mitológicas, ni personajes de obras literarias citadas (p. ej. Rocinante, Apolo, Pegaso), aunque aparezcan como nombre propio. No incluyas al autor del artículo citándose a sí mismo en primera persona.

Responde solo JSON con esta forma exacta:
{"menciones": [{"texto": "forma exacta en que aparece en el artículo", "tipo_probable": "persona|lugar|publicacion|colectivo"}]}`;

function llamarOpenAI(apiKey, textoArticulo) {
  const reqBody = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'user', content: `${PROMPT}\n\nArtículo:\n${(textoArticulo || '').slice(0, 8000)}` },
    ],
    max_tokens: 1000,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (json.error) return reject(new Error(json.error.message));
            resolve(JSON.parse(json.choices[0].message.content).menciones || []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// --- 3. Desambiguación por LLM con contexto, para candidatos inciertos ---
const MAX_CANDIDATOS_DESAMBIGUACION = 12;

function extraerContexto(mencion, textoArticulo, ventana = 200) {
  const idx = textoArticulo.indexOf(mencion);
  if (idx === -1) return textoArticulo.slice(0, ventana * 2);
  const inicio = Math.max(0, idx - ventana);
  const fin = Math.min(textoArticulo.length, idx + mencion.length + ventana);
  return `${inicio > 0 ? '…' : ''}${textoArticulo.slice(inicio, fin)}${fin < textoArticulo.length ? '…' : ''}`;
}

function llamarDesambiguacion(apiKey, mencion, tipoSupuesto, contexto, candidatos) {
  const lista = candidatos
    .map((c, i) => `${i + 1}. ${c.nombre} — tipo: ${c.tipo} — ${(c.texto || '').slice(0, 200)}`)
    .join('\n');
  const prompt = `En un artículo de una revista cultural española (1898-1936) aparece la mención "${mencion}" en este contexto:

"${contexto}"

Un sistema de extracción automática cree que esa mención es de tipo "${tipoSupuesto}" (puede equivocarse). Aquí tienes entradas candidatas de un diccionario de las vanguardias españolas que podrían corresponder a esa mención exacta:

${lista}

¿Cuál de estas entradas es la que se menciona en el contexto? Ten en cuenta que muchas menciones son homónimos casuales (un lugar con el mismo nombre que una persona o una obra, o un apellido compartido por personas distintas): responde solo si estás razonablemente seguro por el contexto (época, tema, relación con otras personas/lugares citados, y si el tipo de la candidata encaja con cómo se usa la mención en la frase) de que es esa entrada y no otra homónima o no relacionada. Si ninguna encaja, o no hay información suficiente para decidir entre varias, responde null.

Responde solo JSON con esta forma exacta: {"eleccion": <número de la entrada, o null>}`;

  const reqBody = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 20,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (json.error) return reject(new Error(json.error.message));
            const parsed = JSON.parse(json.choices[0].message.content);
            resolve(Number.isInteger(parsed.eleccion) ? parsed.eleccion : null);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// Decide si una mención necesita pasar por el LLM de desambiguación:
// varios candidatos, o un único candidato cuyo tipo no cuadra con lo que
// el propio extractor había supuesto (caso "España" -> revista homónima).
function candidatosParaDesambiguar(mencion, resultado) {
  if (resultado.estado === 'exacto') {
    // Una remisión no siempre es la misma identidad (ver "Roland-Manuel.
    // Ver: Falla, Manuel de" — personas distintas relacionadas, no alias):
    // confirmar siempre con contexto, nunca aceptarla a ciegas.
    if (resultado.origen === 'remision') return [resultado.entrada];
    if (resultado.entrada.tipo === mencion.tipo_probable) return null; // nombre completo + tipo: ya seguro
    return [resultado.entrada];
  }
  // Un match "por apellido" es siempre un indicio débil (el apellido puede
  // ser compartido por gente distinta), coincida o no el tipo: confirmar
  // siempre con contexto en vez de aceptarlo a ciegas.
  if (resultado.estado === 'por_apellido') return [resultado.entrada];
  if (resultado.estado === 'ambiguo_apellido') return resultado.candidatos;
  return null; // sin_match / sin_clave / ambiguo_exacto: nada que desambiguar
}

async function fetchArticulos() {
  const filtro = SLUGS.map((s, i) => `filters[slug][$in][${i}]=${encodeURIComponent(s)}`).join('&');
  const url = `${STRAPI_URL}/api/articles?${filtro}&fields[0]=titulo&fields[1]=slug&fields[2]=texto_plano&populate[personas_mencionadas][fields][0]=nombre`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error ${res.status} al pedir artículos`);
  return (await res.json()).data;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada.');

  const gazetteer = construirGazetteer();
  const articulos = await fetchArticulos();
  console.log(`Artículos de prueba: ${articulos.length}\n`);

  const resultadoCompleto = [];

  for (const art of articulos) {
    console.log('='.repeat(70));
    console.log(`ARTÍCULO: ${art.titulo || '(sin título)'} [${art.slug}]`);
    console.log(`Ya vinculado en Strapi (personas_mencionadas): ${(art.personas_mencionadas || []).map((p) => p.nombre).join(', ') || '(ninguna)'}`);
    console.log('-'.repeat(70));

    const menciones = await llamarOpenAI(apiKey, art.texto_plano);
    console.log(`Menciones candidatas extraídas por el LLM: ${menciones.length}\n`);

    const articuloResultado = {
      slug: art.slug,
      titulo: art.titulo,
      personas_mencionadas_strapi: (art.personas_mencionadas || []).map((p) => p.nombre),
      menciones: [],
    };

    for (const m of menciones) {
      const resultado = buscarEnGazetteer(m.texto, gazetteer);
      let linea = `  "${m.texto}" (${m.tipo_probable}) -> `;
      const contexto = extraerContexto(m.texto, art.texto_plano);
      const registro = { texto: m.texto, tipo_probable: m.tipo_probable, contexto, estado: resultado.estado };

      const candidatos = candidatosParaDesambiguar(m, resultado);

      if (candidatos === null && resultado.estado === 'exacto') {
        linea += `MATCH: ${resultado.entrada.nombre} [${resultado.entrada.tipo}]`;
        registro.resultado = 'match_directo';
        registro.match = { nombre: resultado.entrada.nombre, tipo: resultado.entrada.tipo, texto: resultado.entrada.texto };
        // Aquí origen solo puede ser nombre_completo o alias_seudonimo (la
        // remisión siempre pasa por desambiguación, ver candidatosParaDesambiguar).
        registro.metodo = resultado.origen;
        registro.confianza = 'alta';
      } else if (candidatos && candidatos.length > MAX_CANDIDATOS_DESAMBIGUACION) {
        linea += `DEMASIADOS CANDIDATOS (${candidatos.length}) para desambiguar, revisar a mano`;
        registro.resultado = 'demasiados_candidatos';
        registro.num_candidatos = candidatos.length;
      } else if (candidatos) {
        let eleccion;
        try {
          eleccion = await llamarDesambiguacion(apiKey, m.texto, m.tipo_probable, contexto, candidatos);
        } catch (err) {
          linea += `ERROR en desambiguación: ${err.message}`;
          registro.resultado = 'error';
          registro.error = err.message;
          console.log(linea);
          articuloResultado.menciones.push(registro);
          continue;
        }
        const elegido = eleccion && candidatos[eleccion - 1];
        registro.num_candidatos = candidatos.length;
        // metodo/confianza: remisión desambiguada con éxito -> media
        // (identidad relacionada, confirmada por contexto, pero el propio
        // diccionario a veces la usa para una persona distinta, ver
        // "Roland-Manuel"); apellido desambiguado -> baja (siempre a revisar).
        const metodo = resultado.estado === 'exacto' ? 'remision' : 'apellido_desambiguado';
        if (elegido) {
          linea += `MATCH (desambiguado por LLM, ${candidatos.length} candidato${candidatos.length > 1 ? 's' : ''}): ${elegido.nombre} [${elegido.tipo}]`;
          registro.resultado = 'match_desambiguado';
          registro.match = { nombre: elegido.nombre, tipo: elegido.tipo, texto: elegido.texto };
          registro.candidatos_descartados = candidatos.filter((c) => c !== elegido).map((c) => c.nombre);
          registro.metodo = metodo;
          registro.confianza = metodo === 'remision' ? 'media' : 'baja';
        } else {
          linea += `NINGUNO tras desambiguar (${candidatos.length} candidato${candidatos.length > 1 ? 's' : ''} descartado${candidatos.length > 1 ? 's' : ''})`;
          registro.resultado = 'ninguno_tras_desambiguar';
          registro.candidatos_descartados = candidatos.map((c) => c.nombre);
        }
      } else {
        linea += 'SIN MATCH en el diccionario';
        registro.resultado = 'sin_match';
      }
      console.log(linea);
      articuloResultado.menciones.push(registro);
    }
    console.log();
    resultadoCompleto.push(articuloResultado);
  }

  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(resultadoCompleto, null, 2), 'utf8');
    console.log(`\nResultado estructurado guardado en ${OUT_PATH}`);
  }
}

module.exports = {
  construirGazetteer,
  buscarEnGazetteer,
  candidatosParaDesambiguar,
  llamarOpenAI,
  llamarDesambiguacion,
  extraerContexto,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
