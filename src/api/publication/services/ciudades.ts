// Diccionario de coordenadas de ciudades conocidas, para ubicar revistas en
// el mapa a partir de `lugar_publicacion` sin depender de un servicio externo
// de geocodificación (este proyecto no tiene clave/API de geocodificación
// configurada, y el conjunto real de ciudades de origen de las revistas de
// la Edad de Plata española es pequeño y conocido de antemano).
//
// Para añadir una ciudad nueva: añade una entrada con su nombre normalizado
// (ver normalizarNombreCiudad) y sus coordenadas decimales (lat, lng).
const COORDENADAS_CIUDADES: Record<string, { lat: number; lng: number }> = {
  // España: capitales de provincia y otras ciudades habituales como lugar
  // de publicación de revistas culturales del primer tercio del s. XX.
  madrid: { lat: 40.4168, lng: -3.7038 },
  barcelona: { lat: 41.3851, lng: 2.1734 },
  sevilla: { lat: 37.3891, lng: -5.9845 },
  malaga: { lat: 36.7213, lng: -4.4214 },
  valencia: { lat: 39.4699, lng: -0.3763 },
  bilbao: { lat: 43.263, lng: -2.935 },
  santander: { lat: 43.4623, lng: -3.8099 },
  cadiz: { lat: 36.5298, lng: -6.2924 },
  granada: { lat: 37.1773, lng: -3.5986 },
  zaragoza: { lat: 41.6488, lng: -0.8891 },
  vigo: { lat: 42.2406, lng: -8.7207 },
  'la coruna': { lat: 43.3623, lng: -8.4115 },
  coruna: { lat: 43.3623, lng: -8.4115 },
  'san sebastian': { lat: 43.3183, lng: -1.9812 },
  donostia: { lat: 43.3183, lng: -1.9812 },
  'santa cruz de tenerife': { lat: 28.4636, lng: -16.2518 },
  tenerife: { lat: 28.4636, lng: -16.2518 },
  'las palmas de gran canaria': { lat: 28.1235, lng: -15.4366 },
  'las palmas': { lat: 28.1235, lng: -15.4366 },
  burgos: { lat: 42.3439, lng: -3.6969 },
  salamanca: { lat: 40.9701, lng: -5.6635 },
  valladolid: { lat: 41.6523, lng: -4.7245 },
  murcia: { lat: 37.9922, lng: -1.1307 },
  cordoba: { lat: 37.8882, lng: -4.7794 },
  oviedo: { lat: 43.3603, lng: -5.8448 },
  gijon: { lat: 43.5453, lng: -5.6615 },
  toledo: { lat: 39.8628, lng: -4.0273 },
  huelva: { lat: 37.2614, lng: -6.9447 },
  pamplona: { lat: 42.8125, lng: -1.6458 },
  logrono: { lat: 42.4627, lng: -2.4449 },
  caceres: { lat: 39.4753, lng: -6.3724 },
  badajoz: { lat: 38.8794, lng: -6.9707 },
  albacete: { lat: 38.9943, lng: -1.8585 },
  cuenca: { lat: 40.0704, lng: -2.1374 },
  segovia: { lat: 40.9429, lng: -4.1088 },
  avila: { lat: 40.6566, lng: -4.6814 },
  jaen: { lat: 37.7796, lng: -3.7849 },
  almeria: { lat: 36.834, lng: -2.4637 },
  lugo: { lat: 43.0097, lng: -7.5567 },
  pontevedra: { lat: 42.431, lng: -8.6444 },
  ourense: { lat: 42.3358, lng: -7.8639 },
  orense: { lat: 42.3358, lng: -7.8639 },
  ceuta: { lat: 35.8894, lng: -5.3213 },
  melilla: { lat: 35.2923, lng: -2.9381 },

  // Ciudades de exilio donde también se publicaron revistas españolas.
  paris: { lat: 48.8566, lng: 2.3522 },
  'buenos aires': { lat: -34.6037, lng: -58.3816 },
  mexico: { lat: 19.4326, lng: -99.1332 },
  'mexico df': { lat: 19.4326, lng: -99.1332 },
};

// Quita tildes/diéresis y normaliza mayúsculas/espacios, para que "Málaga",
// "MALAGA" o "málaga " encuentren la misma entrada del diccionario.
function normalizarNombreCiudad(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export interface Coordenadas {
  lat: number;
  lng: number;
}

// Busca las coordenadas de una ciudad a partir de un texto libre (p. ej.
// "Madrid", "Madrid, España" o "Sevilla (España)"): primero intenta una
// coincidencia exacta tras normalizar, y si no la encuentra, comprueba si
// alguna ciudad conocida aparece como sub-cadena del texto.
export function buscarCoordenadasPorCiudad(lugarPublicacion: string | null | undefined): Coordenadas | null {
  if (!lugarPublicacion) return null;

  const normalizado = normalizarNombreCiudad(lugarPublicacion);
  if (!normalizado) return null;

  const exacto = COORDENADAS_CIUDADES[normalizado];
  if (exacto) return exacto;

  for (const [ciudad, coordenadas] of Object.entries(COORDENADAS_CIUDADES)) {
    if (normalizado.includes(ciudad)) return coordenadas;
  }

  return null;
}
