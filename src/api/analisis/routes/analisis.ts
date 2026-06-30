export default {
  routes: [
    {
      method: 'GET',
      path: '/analisis/concordancias',
      handler: 'analisis.concordancias',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/estilometria',
      handler: 'analisis.estilometria',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/innovacion',
      handler: 'analisis.innovacion',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/analisis/interpretar-deriva',
      handler: 'analisis.interpretarDeriva',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/cadenas-lexicas',
      handler: 'analisis.cadenasLexicas',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/nube-palabras-autor',
      handler: 'analisis.nubePalabrasAutor',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/nube-palabras-revista',
      handler: 'analisis.nubePalabrasRevista',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/morfologica',
      handler: 'analisis.morfologica',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/publicidad/frecuencia',
      handler: 'analisis.publicidadFrecuencia',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/publicidad/tecnologia',
      handler: 'analisis.publicidadTecnologia',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/publicidad/cadenas-lexicas',
      handler: 'analisis.publicidadCadenasLexicas',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/publicidad/vanguardia',
      handler: 'analisis.publicidadVanguardia',
      config: { auth: false },
    },
  ],
};
