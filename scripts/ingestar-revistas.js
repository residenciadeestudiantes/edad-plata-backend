// USO:
// 1. Genera un API Token en Strapi: Settings > API Tokens > Create new token (tipo Full Access)
// 2. Ejecuta desde backend/: STRAPI_TOKEN=tu_token node scripts/ingestar-revistas.js
//
// Lee revistas_nuevas.xlsx (columnas: Revista, Fecha inicio, Fecha final, Ciudad)
// y crea una Publicación (api::publication.publication) por cada fila, con su
// imagen de portada subida desde la carpeta imagenes_portada/ (el archivo se
// busca por nombre: debe coincidir con el nombre de la revista, ignorando
// mayúsculas/acentos/espacios — p. ej. "Los Cuatro Vientos" -> "Los_Cuatro_Vientos.jpg").
//
// Las publicaciones se crean ya publicadas (?status=published) para que
// aparezcan de inmediato en el sitio. lugar_publicacion activa el hook del
// backend que calcula latitud/longitud para el mapa automáticamente cuando
// la ciudad coincide con el diccionario conocido.
//
// revistas_nuevas.xlsx e imagenes_portada/ viven en la raíz del proyecto, un
// nivel por encima de backend/.

const fs = require('fs')
const path = require('path')
const xlsx = require('xlsx')
const FormData = require('form-data')

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

const STRAPI_URL = 'http://localhost:1337'
const STRAPI_TOKEN = process.env.STRAPI_TOKEN
const EXCEL_PATH = path.join(__dirname, '..', '..', 'revistas_nuevas.xlsx')
const IMAGENES_DIR = path.join(__dirname, '..', '..', 'imagenes_portada')

if (!STRAPI_TOKEN) {
  console.error('Error: define la variable de entorno STRAPI_TOKEN antes de ejecutar el script.')
  console.error('Ejemplo: STRAPI_TOKEN=tu_token node scripts/ingestar-revistas.js')
  process.exit(1)
}

const jsonHeaders = {
  Authorization: `Bearer ${STRAPI_TOKEN}`,
  'Content-Type': 'application/json',
}

const informe = {
  procesados: 0,
  creados: 0,
  imagenesSubidas: 0,
  sinImagen: [],
  errores: [],
}

function generateSlug(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

// Mismo criterio que generateSlug, pero pensado para comparar nombres de
// revista con nombres de archivo de imagen (que usan "_" en vez de " ").
function normalizarNombre(texto) {
  return String(texto || '')
    .replace(/_/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

function indexarImagenes() {
  const indice = new Map()
  for (const archivo of fs.readdirSync(IMAGENES_DIR)) {
    const nombreSinExtension = path.basename(archivo, path.extname(archivo))
    indice.set(normalizarNombre(nombreSinExtension), archivo)
  }
  return indice
}

async function existeSlug(slug) {
  const url = `${STRAPI_URL}/api/publications?filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=id`
  const res = await fetch(url, { headers: jsonHeaders })
  if (!res.ok) {
    throw new Error(`Error comprobando slug "${slug}": HTTP ${res.status}`)
  }
  const json = await res.json()
  return Boolean(json.data && json.data.length > 0)
}

async function subirImagenLocal(rutaArchivo) {
  const buffer = fs.readFileSync(rutaArchivo)
  const form = new FormData()
  form.append('files', buffer, path.basename(rutaArchivo))

  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...form.getHeaders(),
    },
    body: form,
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Error subiendo imagen a Strapi: HTTP ${res.status} ${errBody}`)
  }
  const json = await res.json()
  return json[0].id
}

async function procesarFila(fila, indiceImagenes) {
  const titulo = String(fila['Revista'] || '').trim()
  const añoInicio = Number(fila['Fecha inicio']) || null
  const añoFin = Number(fila['Fecha final']) || null
  const lugarPublicacion = String(fila['Ciudad'] || '').trim() || null

  let slug = generateSlug(titulo)
  if (await existeSlug(slug)) {
    informe.errores.push(`[${titulo}]: ya existe una publicación con el slug "${slug}", se omite`)
    return
  }

  let imagenId = null
  const archivoImagen = indiceImagenes.get(normalizarNombre(titulo))
  if (archivoImagen) {
    try {
      imagenId = await subirImagenLocal(path.join(IMAGENES_DIR, archivoImagen))
      informe.imagenesSubidas++
    } catch (err) {
      informe.errores.push(`[${titulo}] imagen: ${err.message}`)
    }
  } else {
    informe.sinImagen.push(titulo)
  }

  const data = {
    titulo,
    slug,
    año_inicio: añoInicio,
    año_fin: añoFin,
    lugar_publicacion: lugarPublicacion,
    imagen_portada: imagenId,
  }

  const res = await fetch(`${STRAPI_URL}/api/publications?status=published`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ data }),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`HTTP ${res.status} ${errBody}`)
  }

  informe.creados++
}

function imprimirInforme() {
  console.log('\n=== INFORME DE INGESTA ===')
  console.log(`Revistas procesadas: ${informe.procesados}`)
  console.log(`Revistas creadas: ${informe.creados}`)
  console.log(`Imágenes subidas: ${informe.imagenesSubidas}`)

  if (informe.sinImagen.length > 0) {
    console.log('\nRevistas sin imagen de portada encontrada:')
    for (const titulo of informe.sinImagen) {
      console.log(`- ${titulo}`)
    }
  }

  if (informe.errores.length > 0) {
    console.log('\nERRORES:')
    for (const error of informe.errores) {
      console.log(`- ${error}`)
    }
  }
}

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`No se encuentra el fichero Excel en: ${EXCEL_PATH}`)
    process.exit(1)
  }
  if (!fs.existsSync(IMAGENES_DIR)) {
    console.error(`No se encuentra la carpeta de imágenes en: ${IMAGENES_DIR}`)
    process.exit(1)
  }

  const indiceImagenes = indexarImagenes()

  const workbook = xlsx.readFile(EXCEL_PATH)
  const hoja = workbook.Sheets[workbook.SheetNames[0]]
  const filas = xlsx.utils.sheet_to_json(hoja, { defval: '' })

  for (const fila of filas) {
    informe.procesados++
    const titulo = String(fila['Revista'] || 'sin título').trim()
    try {
      await procesarFila(fila, indiceImagenes)
    } catch (err) {
      informe.errores.push(`[${titulo}]: ${err.message}`)
    }
  }

  imprimirInforme()
}

main().catch((err) => {
  console.error('Error fatal durante la ingesta:', err)
  process.exit(1)
})
