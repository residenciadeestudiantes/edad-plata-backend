#!/usr/bin/env node
// Parsea el XML de layout (pdftohtml -xml -i) del diccionario de vanguardias
// y reconstruye las entradas (lema + definición) usando el formato: cada
// entrada empieza con un tramo en negrita pegado al margen izquierdo de la
// columna, justo después de que la entrada anterior termine en punto.
//
// Entrada: backend/diccionarios/raw.xml (generado con:
//   pdftohtml -xml -i -stdout diccionario-vanguardias.pdf > raw.xml)
// Salida:  backend/diccionarios/entradas.json
//
// Uso:
//   node scripts/diccionario_parsear.js [--muestra=20]

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'diccionarios');
const XML_PATH = path.join(DIR, 'raw.xml');
const OUT_PATH = path.join(DIR, 'entradas.json');

const args = process.argv.slice(2);
const muestraArg = args.find((a) => a.startsWith('--muestra='));
const MUESTRA = muestraArg ? parseInt(muestraArg.split('=')[1], 10) : 0;

const MARGEN_IZQUIERDO_MAX = 140; // left="135" es el margen de columna observado
const SALTO_VERTICAL_MIN = 30; // separación de párrafo observada (~38pt) vs línea normal (~20-21pt)

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function terminaEnPunto(texto) {
  const t = texto.trim();
  return /[.?!»)]$/.test(t);
}

function main() {
  const xml = fs.readFileSync(XML_PATH, 'utf8');
  const lineas = xml.split('\n');

  const PAGE_RE = /<page number="(\d+)"/;
  const TEXT_RE = /<text top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" font="\d+">(.*)<\/text>/;

  const elementos = [];
  let pagina = 0;

  for (const linea of lineas) {
    const pageMatch = PAGE_RE.exec(linea);
    if (pageMatch) {
      pagina = parseInt(pageMatch[1], 10);
      continue;
    }
    const m = TEXT_RE.exec(linea);
    if (!m) continue;
    const [, top, left, , , contenidoCrudo] = m;
    const negrita = /<b>/.test(contenidoCrudo);
    const texto = decodeEntities(contenidoCrudo.replace(/<\/?[a-z]>/g, ''));
    elementos.push({ pagina, top: parseInt(top, 10), left: parseInt(left, 10), negrita, texto });
  }

  console.log(`Elementos de texto leídos: ${elementos.length}`);

  const entradas = [];
  let actual = null;
  let enCabecera = false;

  for (let i = 0; i < elementos.length; i++) {
    const el = elementos[i];
    const anterior = i > 0 ? elementos[i - 1] : null;

    const enMargen = el.left <= MARGEN_IZQUIERDO_MAX;
    const primerElemento = i === 0;
    const primeroDePagina = anterior && anterior.pagina !== el.pagina;
    const saltoGrande =
      anterior && !primeroDePagina && el.pagina === anterior.pagina && el.top - anterior.top >= SALTO_VERTICAL_MIN;
    // Ojo: el elemento anterior puede ser un espaciador en blanco ("<text> </text>"),
    // así que miramos el último texto no vacío acumulado en la entrada en curso, no
    // el elemento crudo inmediatamente anterior.
    const anteriorTerminaEntrada = actual
      ? terminaEnPunto(actual.texto || actual.lema)
      : true;

    const esNuevaEntrada =
      el.negrita &&
      enMargen &&
      anteriorTerminaEntrada &&
      (primerElemento || primeroDePagina || saltoGrande);

    if (esNuevaEntrada) {
      if (actual) entradas.push(actual);
      actual = { pagina_inicio: el.pagina, lema: '', texto: '' };
      enCabecera = true;
    }

    if (!actual) continue; // texto antes de la primera entrada detectada (portada, índice...)

    if (enCabecera && el.negrita) {
      actual.lema += el.texto;
    } else {
      enCabecera = false;
      actual.texto += el.texto;
    }
  }
  if (actual) entradas.push(actual);

  for (const e of entradas) {
    e.lema = e.lema.replace(/\s+/g, ' ').trim();
    e.texto = e.texto.replace(/\s+/g, ' ').trim();

    // Fallo puntual de tipografía del original: el ")." de cierre del lema
    // no está en negrita como el resto y queda al principio del cuerpo.
    const cierreSuelto = /^\)\.?\s*/.exec(e.texto);
    if (cierreSuelto) {
      e.lema = e.lema.replace(/\.?$/, '') + ').';
      e.texto = e.texto.slice(cierreSuelto[0].length).trim();
    }
  }

  console.log(`Entradas detectadas: ${entradas.length}`);

  const cortas = entradas.filter((e) => e.texto.length < 5);
  const sinLema = entradas.filter((e) => !e.lema);
  console.log(`  con texto sospechosamente corto (<5 car.): ${cortas.length}`);
  console.log(`  sin lema: ${sinLema.length}`);

  fs.writeFileSync(OUT_PATH, JSON.stringify(entradas, null, 2), 'utf8');
  console.log(`Guardado en ${OUT_PATH}`);

  if (MUESTRA > 0) {
    console.log(`\n--- Muestra de ${MUESTRA} entradas ---`);
    for (const e of entradas.slice(0, MUESTRA)) {
      console.log(`\n[p.${e.pagina_inicio}] ${e.lema}`);
      console.log(`  ${e.texto.slice(0, 160)}${e.texto.length > 160 ? '…' : ''}`);
    }
  }
}

main();
