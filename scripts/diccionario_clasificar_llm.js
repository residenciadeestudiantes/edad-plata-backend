#!/usr/bin/env node
// Clasifica entradas del diccionario de vanguardias en un tipo cerrado
// usando gpt-4o-mini, igual que clasificar_temas_llm.js hace con los
// artículos. Clasifica desde cero (nombre + texto) sin decirle al modelo
// la heurística previa (tipo_inferido), para poder comparar acuerdo/
// desacuerdo y detectar dónde falla la heurística de diccionario_separar.js.
//
// Salta las remisiones ("Ver: X"): no tienen contenido propio que clasificar.
//
// Uso:
//   OPENAI_API_KEY=... node scripts/diccionario_clasificar_llm.js [--limit=40] [--todo]

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DIR = path.join(__dirname, '..', 'diccionarios');
const IN_PATH = path.join(DIR, 'entradas_estructuradas.json');
const OUT_PATH = path.join(DIR, 'entradas_clasificadas_llm.json');

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const concurrenciaArg = args.find((a) => a.startsWith('--concurrencia='));
const TODO = args.includes('--todo');
const REINTENTAR = args.includes('--reintentar');
const LIMITE = limitArg ? parseInt(limitArg.split('=')[1], 10) : TODO ? Infinity : 40;
const CONCURRENCIA = concurrenciaArg ? parseInt(concurrenciaArg.split('=')[1], 10) : 6;

const TIPOS = ['persona', 'lugar', 'publicacion', 'colectivo', 'movimiento', 'otro'];

const PROMPT_BASE = `Clasifica la siguiente entrada de un diccionario biográfico y de instituciones de las vanguardias artísticas españolas (1898-1936) en una de estas categorías:

- persona: una persona real (escritor, artista, arquitecto, músico, etc.), incluidos los seudónimos.
- lugar: una ciudad, provincia o región.
- publicacion: una revista, periódico, boletín, almanaque o libro considerado como obra editorial.
- colectivo: un grupo, asociación, institución, exposición colectiva o evento organizado.
- movimiento: una corriente o movimiento artístico o literario (un "-ismo", una escuela, una tendencia).
- otro: cualquier cosa que no encaje claramente en las anteriores.

Instrucciones:
- Usa exactamente una de esas seis palabras, en minúscula.
- Responde solo JSON con esta forma exacta: {"tipo": "categoria"}`;

function llamarOpenAI(apiKey, nombre, texto) {
  const textoRecortado = (texto || '').slice(0, 2000);
  const prompt = `${PROMPT_BASE}\n\nLema: ${nombre}\n\nTexto: ${textoRecortado}`;

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
            resolve(parsed.tipo);
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

// Muestra estratificada: recorre cada bucket de tipo_inferido en round-robin
// para que una muestra pequeña no sea solo "persona" (el 58% del total).
function muestraEstratificada(entradas, n) {
  const buckets = new Map();
  for (const e of entradas) {
    if (!buckets.has(e.tipo_inferido)) buckets.set(e.tipo_inferido, []);
    buckets.get(e.tipo_inferido).push(e);
  }
  const listas = [...buckets.values()];
  const resultado = [];
  let i = 0;
  while (resultado.length < n && listas.some((l) => i < l.length)) {
    for (const l of listas) {
      if (i < l.length) resultado.push(l[i]);
      if (resultado.length >= n) break;
    }
    i++;
  }
  return resultado;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada.');

  const todas = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  const candidatas = todas.filter((e) => !e.es_remision);
  console.log(`Entradas totales: ${todas.length} (remisiones excluidas: ${todas.length - candidatas.length})`);

  let yaClasificadas = [];
  let entradas;
  if (REINTENTAR) {
    yaClasificadas = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    const yaClasificadasIds = new Set(yaClasificadas.map((e) => e.pagina_inicio + '|' + e.lema));
    entradas = candidatas.filter((e) => !yaClasificadasIds.has(e.pagina_inicio + '|' + e.lema));
    console.log(`Ya clasificadas: ${yaClasificadas.length}. Pendientes de reintentar: ${entradas.length}\n`);
  } else {
    entradas = Number.isFinite(LIMITE) ? muestraEstratificada(candidatas, LIMITE) : candidatas;
    console.log(`Entradas a clasificar por LLM: ${entradas.length}${Number.isFinite(LIMITE) ? ' (muestra estratificada)' : ''}\n`);
  }

  const resultado = [...yaClasificadas];
  const conteoAcuerdo = { acuerdo: 0, desacuerdo: 0, error: 0 };
  const mapaHeuristicaALlm = {
    persona: 'persona',
    lugar_o_tema: null, // puede acabar en lugar, movimiento u otro; no hay 1-a-1
    colectivo_o_publicacion: null, // puede acabar en publicacion o colectivo
  };

  let siguiente = 0;
  let completadas = 0;

  async function trabajador() {
    while (siguiente < entradas.length) {
      const i = siguiente++;
      const e = entradas[i];
      let tipoLlm;
      try {
        tipoLlm = await llamarOpenAI(apiKey, e.nombre, e.texto);
      } catch (err) {
        console.error(`  ✗ Error en "${e.nombre}": ${err.message}`);
        conteoAcuerdo.error++;
        completadas++;
        continue;
      }

      if (!TIPOS.includes(tipoLlm)) {
        console.warn(`  ⚠ Tipo inválido devuelto para "${e.nombre}": ${JSON.stringify(tipoLlm)}`);
      }

      const esperado = mapaHeuristicaALlm[e.tipo_inferido];
      const acuerdo = esperado === null ? null : esperado === tipoLlm;
      if (acuerdo === true) conteoAcuerdo.acuerdo++;
      else if (acuerdo === false) conteoAcuerdo.desacuerdo++;

      resultado.push({ ...e, tipo_llm: tipoLlm });
      completadas++;

      const marca = acuerdo === false ? ' ⚠ DIFIERE de la heurística' : '';
      console.log(`  [${completadas}/${entradas.length}] ${e.nombre} — heurística: ${e.tipo_inferido} / LLM: ${tipoLlm}${marca}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCIA, entradas.length) }, trabajador));

  fs.writeFileSync(OUT_PATH, JSON.stringify(resultado, null, 2), 'utf8');
  console.log(`\nGuardado en ${OUT_PATH}`);

  console.log('\n--- Resumen ---');
  console.log(`Coincide con la heurística (solo aplica a tipo_inferido=persona): ${conteoAcuerdo.acuerdo}`);
  console.log(`Difiere de la heurística: ${conteoAcuerdo.desacuerdo}`);
  console.log(`Errores: ${conteoAcuerdo.error}`);

  const conteoTiposLlm = new Map();
  for (const e of resultado) conteoTiposLlm.set(e.tipo_llm, (conteoTiposLlm.get(e.tipo_llm) || 0) + 1);
  console.log('\nDistribución tipo_llm:', JSON.stringify(Object.fromEntries(conteoTiposLlm), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
