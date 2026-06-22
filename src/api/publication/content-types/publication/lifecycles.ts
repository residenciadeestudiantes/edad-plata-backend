// Al crear o editar una publicación, si se indica `lugar_publicacion` y no
// se han introducido manualmente latitud/longitud, las rellena buscando la
// ciudad en el diccionario conocido (ver services/ciudades.ts). Así el
// módulo de mapa puede ubicar cada revista sin que haya que introducir
// coordenadas a mano para las ciudades habituales.
import { buscarCoordenadasPorCiudad } from '../../services/ciudades';

interface PublicationData {
  lugar_publicacion?: string | null;
  latitud?: number | null;
  longitud?: number | null;
}

function rellenarCoordenadas(data: PublicationData) {
  if (!data.lugar_publicacion) return;
  if (data.latitud != null && data.longitud != null) return;

  const coordenadas = buscarCoordenadasPorCiudad(data.lugar_publicacion);
  if (!coordenadas) return;

  data.latitud = coordenadas.lat;
  data.longitud = coordenadas.lng;
}

export default {
  beforeCreate(event: { params: { data: PublicationData } }) {
    rellenarCoordenadas(event.params.data);
  },
  beforeUpdate(event: { params: { data: PublicationData } }) {
    rellenarCoordenadas(event.params.data);
  },
};
