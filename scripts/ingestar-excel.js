// USO:
// 1. Genera un API Token en Strapi: Settings > API Tokens > Create new token (tipo Full Access)
// 2. Ejecuta desde backend/: STRAPI_TOKEN=tu_token node scripts/ingestar-excel.js
// 3. Asegúrate de que el ejemplar_id=46 existe en Strapi antes de ejecutar
//
// Nota: los nombres de relación usados al crear el artículo (`issue`, `authors`)
// se corresponden con los definidos en src/api/article/content-types/article/schema.json
//
// El Excel (articulos_revistas_test.xlsx) vive en la raíz del proyecto, un nivel
// por encima de backend/, junto al resto de ficheros de datos de ingesta.

const fs = require('fs')
const path = require('path')
const xlsx = require('xlsx')
const FormData = require('form-data')

// node-fetch v3 es ESM-only; se importa dinámicamente para poder usarlo desde CommonJS
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args))

const STRAPI_URL = 'http://localhost:1337'
const STRAPI_TOKEN = process.env.STRAPI_TOKEN // API token de Strapi
const EXCEL_PATH = path.join(__dirname, '..', '..', 'articulos_revistas_test.xlsx')

if (!STRAPI_TOKEN) {
  console.error('Error: define la variable de entorno STRAPI_TOKEN antes de ejecutar el script.')
  console.error('Ejemplo: STRAPI_TOKEN=tu_token node scripts/ingestar-excel.js')
  process.exit(1)
}

const jsonHeaders = {
  Authorization: `Bearer ${STRAPI_TOKEN}`,
  'Content-Type': 'application/json',
}

const informe = {
  procesados: 0,
  creados: 0,
  autoresCreados: 0,
  autoresExistentes: 0,
  imagenesSubidas: 0,
  imagenesError: 0,
  articulosError: 0,
  errores: [],
}

const cacheAutores = new Map()

function generateSlug(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
}

function sanitizarHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<a[^>]*href="javascript:[^"]*"[^>]*>.*?<\/a>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

async function resolverAutor(autorId, nombreAutor) {
  if (cacheAutores.has(autorId)) return cacheAutores.get(autorId)

  // El slug se genera a partir del nombre (kebab-case, igual que el resto del
  // proyecto) en vez de usar el autor_id del Excel tal cual: ese campo puede
  // venir con guiones bajos u otro formato y no coincidiría con autores ya
  // existentes creados desde el admin de Strapi, generando duplicados.
  const slug = generateSlug(nombreAutor || autorId)

  const buscarUrl = `${STRAPI_URL}/api/authors?filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=id&fields[1]=nombre`
  const buscarRes = await fetch(buscarUrl, { headers: jsonHeaders })
  if (!buscarRes.ok) {
    throw new Error(`Error buscando autor "${autorId}": HTTP ${buscarRes.status}`)
  }
  const buscarJson = await buscarRes.json()

  if (buscarJson.data && buscarJson.data.length > 0) {
    const id = buscarJson.data[0].id
    cacheAutores.set(autorId, id)
    informe.autoresExistentes++
    return id
  }

  const crearRes = await fetch(`${STRAPI_URL}/api/authors`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      data: {
        nombre: nombreAutor || autorId,
        slug,
        nombre_normalizado: autorId.replace(/_/g, ' '),
      },
    }),
  })
  if (!crearRes.ok) {
    const errBody = await crearRes.text()
    throw new Error(`Error creando autor "${autorId}": HTTP ${crearRes.status} ${errBody}`)
  }
  const crearJson = await crearRes.json()
  const nuevoId = crearJson.data.id
  cacheAutores.set(autorId, nuevoId)
  informe.autoresCreados++
  return nuevoId
}

async function subirImagen(url) {
  const descargaRes = await fetch(url)
  if (!descargaRes.ok) {
    throw new Error(`No se pudo descargar la imagen (HTTP ${descargaRes.status})`)
  }
  const arrayBuffer = await descargaRes.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  let filename = 'imagen.jpg'
  try {
    filename = path.basename(new URL(url).pathname) || filename
  } catch {
    // url no parseable como URL absoluta; se usa el nombre por defecto
  }

  const form = new FormData()
  form.append('files', buffer, filename)

  const subidaRes = await fetch(`${STRAPI_URL}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRAPI_TOKEN}`,
      ...form.getHeaders(),
    },
    body: form,
  })
  if (!subidaRes.ok) {
    const errBody = await subidaRes.text()
    throw new Error(`Error subiendo imagen a Strapi: HTTP ${subidaRes.status} ${errBody}`)
  }
  const subidaJson = await subidaRes.json()
  return subidaJson[0].id
}

async function existeSlug(slug) {
  const url = `${STRAPI_URL}/api/articles?filters[slug][$eq]=${encodeURIComponent(slug)}&fields[0]=id`
  const res = await fetch(url, { headers: jsonHeaders })
  if (!res.ok) {
    throw new Error(`Error comprobando slug "${slug}": HTTP ${res.status}`)
  }
  const json = await res.json()
  return Boolean(json.data && json.data.length > 0)
}

async function procesarFila(fila, index) {
  const tituloArticulo = String(fila.articulo_titulo || '').trim()

  // Paso 2 — resolver autor
  const autorId = String(fila.autor_id || '').trim()
  const nombreAutor = String(fila.articulo_autor || '').trim()
  let autorStrapiId = null
  if (autorId) {
    autorStrapiId = await resolverAutor(autorId, nombreAutor)
  }

  // Paso 3 — subir imágenes
  const imagenesIds = []
  const columnasImagen = ['url_1_imagen', 'url_2_imagen', 'url_3_imagen', 'url_4_imagen']
  for (const columna of columnasImagen) {
    const url = String(fila[columna] || '').trim()
    if (!url) continue
    try {
      const imagenId = await subirImagen(url)
      imagenesIds.push(imagenId)
      informe.imagenesSubidas++
    } catch (err) {
      informe.imagenesError++
      informe.errores.push(`[${tituloArticulo || 'sin título'}] ${columna}: ${err.message}`)
    }
  }

  // Paso 4 — sanitizar HTML
  const textoSanitizado = sanitizarHtml(fila.articulo_html)

  // Paso 5 — slug único
  let slug = generateSlug(tituloArticulo)
  if (await existeSlug(slug)) {
    slug = `${slug}-${fila.articulo_id}`
  }

  const data = {
    titulo: tituloArticulo,
    slug,
    texto: textoSanitizado,
    posicion: index + 1,
    issue: fila.ejemplar_id,
    authors: autorStrapiId ? [autorStrapiId] : [],
    imagenes: imagenesIds,
  }

  const res = await fetch(`${STRAPI_URL}/api/articles`, {
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
  console.log(`Artículos procesados: ${informe.procesados}`)
  console.log(`Artículos creados: ${informe.creados}`)
  console.log(`Autores creados: ${informe.autoresCreados}`)
  console.log(`Autores ya existentes: ${informe.autoresExistentes}`)
  console.log(`Imágenes subidas: ${informe.imagenesSubidas}`)
  console.log(`Imágenes con error: ${informe.imagenesError}`)
  console.log(`Artículos con error: ${informe.articulosError}`)

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

  const workbook = xlsx.readFile(EXCEL_PATH)
  const hoja = workbook.Sheets[workbook.SheetNames[0]]
  const filas = xlsx.utils.sheet_to_json(hoja, { defval: '' })

  for (let index = 0; index < filas.length; index++) {
    const fila = filas[index]
    informe.procesados++
    try {
      await procesarFila(fila, index)
    } catch (err) {
      informe.articulosError++
      const titulo = String(fila.articulo_titulo || 'sin título').trim()
      informe.errores.push(`[${titulo}]: ${err.message}`)
    }
  }

  imprimirInforme()
}

main().catch((err) => {
  console.error('Error fatal durante la ingesta:', err)
  process.exit(1)
})
