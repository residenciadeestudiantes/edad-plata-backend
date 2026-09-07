#!/usr/bin/env node
// Segunda pasada sobre backend/diccionarios/entradas.json: separa el lema en
// nombre + lugar/año de nacimiento y muerte (cuando aplica), detecta
// remisiones ("Ver: X") y seudónimos ("Seudónimo de X"), e infiere un
// `tipo` provisional por heurística (a confirmar/afinar después con LLM,
// igual que se hace con `tema` en clasificar_temas_llm.js).
//
// Entrada: backend/diccionarios/entradas.json
// Salida:  backend/diccionarios/entradas_estructuradas.json
//
// Uso:
//   node scripts/diccionario_separar.js [--muestra=10]

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'diccionarios');
const IN_PATH = path.join(DIR, 'entradas.json');
const OUT_PATH = path.join(DIR, 'entradas_estructuradas.json');

const args = process.argv.slice(2);
const muestraArg = args.find((a) => a.startsWith('--muestra='));
const MUESTRA = muestraArg ? parseInt(muestraArg.split('=')[1], 10) : 0;

// Separa un bloque tipo "LUGAR, LUGAR, 1913" o "1913" o "¿" en {lugar, anio}.
function partirBloque(bloque) {
  const b = bloque.trim();
  if (!b) return { lugar: null, anio: null, anio_desconocido: false };
  const partes = b.split(',').map((s) => s.trim()).filter(Boolean);
  if (partes.length === 0) return { lugar: null, anio: null, anio_desconocido: false };
  const ultimo = partes[partes.length - 1];
  const esDesconocido = ultimo === '?' || ultimo === '¿';
  const esAnio = /^\d{4}$/.test(ultimo) || esDesconocido;
  if (esAnio) {
    const lugar = partes.slice(0, -1).join(', ') || null;
    return {
      lugar,
      anio: esDesconocido ? null : parseInt(ultimo, 10),
      anio_desconocido: esDesconocido,
    };
  }
  return { lugar: partes.join(', '), anio: null, anio_desconocido: false };
}

// Divide el contenido de un paréntesis en inicio/fin (nacimiento-muerte para
// una persona, fundación-cierre para un colectivo o publicación). El
// separador real es un guion precedido de un dígito o de un marcador de año
// desconocido ("?" o "¿": el diccionario usa ambos) — los lugares con guion
// interno, como CHARENTON-LE-PONT, van precedidos de letras, no de eso.
function parsearParentesis(contenido) {
  const c = contenido.trim();
  const sep = /([\d?¿])\s*-\s*/.exec(c);
  if (!sep) {
    return { inicio: partirBloque(c), fin: null, parseado: true };
  }
  const finNac = sep.index + 1;
  const inicioMuerte = sep.index + sep[0].length;
  return {
    inicio: partirBloque(c.slice(0, finNac)),
    fin: partirBloque(c.slice(inicioMuerte)),
    parseado: true,
  };
}

function extraerNombreYParentesis(lema) {
  const sinFinal = lema.trim().replace(/\.$/, '');
  const numParens = (lema.match(/\(/g) || []).length;
  const m = /^(.*?)\s*\(([^()]*)\)\s*\.?$/.exec(lema.trim());
  if (!m) {
    return { nombre: sinFinal, parentesisRaw: null, multiplesEntidades: numParens > 1 };
  }
  return { nombre: m[1].trim(), parentesisRaw: m[2], multiplesEntidades: numParens > 1 };
}

// Un acrónimo como cabecera ("GATCPAC, Grupo de..." / "A.C., Documentos...")
// es una señal fuerte de colectivo o publicación, con independencia de lo
// larga que sea la descripción que sigue a la coma.
const RE_ACRONIMO = /^[A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ.]{1,9}$/;

// Palabras que delatan una descripción institucional (grupo, revista,
// asociación...) cuando aparecen tras la coma en el lema.
const RE_PALABRA_INSTITUCIONAL =
  /\b(grupo|asociaci[oó]n|revista|boletín|exposici[oó]n|sociedad|club|colegio|instituto|comit[eé]|congreso|movimiento|partido|frente|federaci[oó]n|uni[oó]n|c[ií]rculo|ateneo|ministerio|cineclub|editorial|compañ[ií]a|junta|academia)\b/i;

// Título de obra/publicación catalogado con el artículo pospuesto para
// alfabetizar: "Verdad, La" = La Verdad; "Acabóse..., El" = El Acabóse...
const RE_ARTICULO_POSPUESTO = /^(el|la|los|las|lo)$/i;

function inferirTipo({ esRemision, esSeudonimo, nombre, parentesisInfo }) {
  if (esRemision) return 'remision';
  if (esSeudonimo) return 'persona';
  if (/seudónimo\s+de/i.test(nombre)) return 'persona';

  const comaIdx = nombre.lastIndexOf(',');
  if (comaIdx !== -1 && RE_ARTICULO_POSPUESTO.test(nombre.slice(comaIdx + 1).trim())) {
    return 'colectivo_o_publicacion';
  }

  if (parentesisInfo) {
    if (comaIdx === -1) return 'colectivo_o_publicacion';

    const antesComa = nombre.slice(0, comaIdx).trim();
    const trasComa = nombre.slice(comaIdx + 1).trim();
    if (RE_ACRONIMO.test(antesComa) || RE_PALABRA_INSTITUCIONAL.test(trasComa)) {
      return 'colectivo_o_publicacion';
    }
    const numPalabras = trasComa.split(/\s+/).filter(Boolean).length;
    return numPalabras > 0 && numPalabras <= 6 ? 'persona' : 'colectivo_o_publicacion';
  }

  return 'lugar_o_tema';
}

function main() {
  const entradas = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  console.log(`Entradas leídas: ${entradas.length}`);

  const resultado = entradas.map((e) => {
    const remMatch = /^Ver:\s*(.+?)\.?\s*$/i.exec(e.texto);
    const esRemision = !!remMatch;

    // Ojo: no basta con un ".+?" perezoso anclado a "$" — cuando el patrón
    // aparece al principio de un texto largo, esa combinación captura TODA
    // la biografía hasta el último punto del texto, no solo el nombre.
    // Cortamos en el primer paréntesis (si lo hay, ahí empiezan lugar/año)
    // o si no en el primer punto.
    const seudPrefijo = /^(?:Otro\s+)?[Ss]eudónimo\s+de\s+/.exec(e.texto);
    const esSeudonimo = !!seudPrefijo;
    let nombreReal;
    if (esSeudonimo) {
      const resto = e.texto.slice(seudPrefijo[0].length);
      const idxParen = resto.indexOf('(');
      const idxPunto = resto.indexOf('.');
      const corte = idxParen !== -1 && (idxPunto === -1 || idxParen < idxPunto) ? idxParen : idxPunto;
      nombreReal = (corte === -1 ? resto : resto.slice(0, corte)).trim();
    }

    const { nombre, parentesisRaw, multiplesEntidades } = extraerNombreYParentesis(e.lema);
    const parentesisInfo = parentesisRaw !== null ? parsearParentesis(parentesisRaw) : null;

    const tipo = inferirTipo({ esRemision, esSeudonimo, nombre, parentesisInfo });

    return {
      ...e,
      nombre,
      multiples_entidades: multiplesEntidades || undefined,
      lugar_inicio: parentesisInfo?.inicio?.lugar ?? undefined,
      anio_inicio: parentesisInfo?.inicio?.anio ?? undefined,
      lugar_fin: parentesisInfo?.fin?.lugar ?? undefined,
      anio_fin: parentesisInfo?.fin?.anio ?? undefined,
      es_remision: esRemision || undefined,
      remite_a: esRemision ? remMatch[1].trim() : undefined,
      es_seudonimo: esSeudonimo || undefined,
      nombre_real: esSeudonimo ? nombreReal : undefined,
      tipo_inferido: tipo,
    };
  });

  fs.writeFileSync(OUT_PATH, JSON.stringify(resultado, null, 2), 'utf8');
  console.log(`Guardado en ${OUT_PATH}\n`);

  const conteoTipos = new Map();
  for (const e of resultado) conteoTipos.set(e.tipo_inferido, (conteoTipos.get(e.tipo_inferido) || 0) + 1);
  console.log('--- Distribución de tipo_inferido ---');
  for (const [tipo, n] of [...conteoTipos.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tipo}: ${n}`);
  }

  const multiples = resultado.filter((e) => e.multiples_entidades);
  console.log(`\nEntradas con más de un paréntesis (posibles entidades conjuntas, revisar a mano): ${multiples.length}`);
  multiples.slice(0, 5).forEach((e) => console.log('  -', e.lema));

  if (MUESTRA > 0) {
    console.log(`\n--- Muestra de ${MUESTRA} entradas estructuradas ---`);
    const paso = Math.max(1, Math.floor(resultado.length / MUESTRA));
    for (let i = 0; i < resultado.length; i += paso) {
      const e = resultado[i];
      console.log(`\n[${e.tipo_inferido}] ${e.nombre}`);
      if (e.anio_inicio || e.lugar_inicio) {
        console.log(`  inicio: ${e.lugar_inicio ?? '?'}, ${e.anio_inicio ?? '?'}`);
      }
      if (e.anio_fin || e.lugar_fin) {
        console.log(`  fin: ${e.lugar_fin ?? '?'}, ${e.anio_fin ?? '?'}`);
      }
      if (e.remite_a) console.log(`  remite a: ${e.remite_a}`);
      if (e.nombre_real) console.log(`  nombre real: ${e.nombre_real}`);
    }
  }
}

main();
