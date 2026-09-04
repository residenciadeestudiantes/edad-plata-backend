#!/usr/bin/env node
// Une entradas_estructuradas.json (remisiones incluidas) con
// entradas_clasificadas_llm.json (tipo_llm para las no-remisión) en un
// único fichero con un solo campo `tipo` final:
//   - remisiones -> 'remision' (ya lo sabíamos por estructura, sin LLM)
//   - resto -> tipo_llm devuelto por gpt-4o-mini
//
// Salida: backend/diccionarios/entradas_finales.json

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'diccionarios');
const estructuradas = JSON.parse(fs.readFileSync(path.join(DIR, 'entradas_estructuradas.json'), 'utf8'));
const clasificadas = JSON.parse(fs.readFileSync(path.join(DIR, 'entradas_clasificadas_llm.json'), 'utf8'));

const tipoLlmPorClave = new Map(clasificadas.map((e) => [e.pagina_inicio + '|' + e.lema, e.tipo_llm]));

let sinClasificar = 0;
const finales = estructuradas.map((e) => {
  const { tipo_inferido, ...resto } = e;
  const tipo = e.es_remision ? 'remision' : tipoLlmPorClave.get(e.pagina_inicio + '|' + e.lema);
  if (!tipo) sinClasificar++;
  return { ...resto, tipo: tipo || null };
});

fs.writeFileSync(path.join(DIR, 'entradas_finales.json'), JSON.stringify(finales, null, 2), 'utf8');

console.log(`Entradas finales: ${finales.length}`);
console.log(`Sin tipo (no clasificadas ni remisión): ${sinClasificar}`);

const conteo = new Map();
for (const e of finales) conteo.set(e.tipo, (conteo.get(e.tipo) || 0) + 1);
console.log('\nDistribución final de tipo:');
for (const [tipo, n] of [...conteo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tipo}: ${n}`);
}
