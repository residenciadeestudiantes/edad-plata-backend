// PROTOTIPO DE VALIDACIÓN: respuesta hardcodeada que simula Amazon Q Business.
// En producción este endpoint llamará a AWS Q Business API (chatSync)
// con las credenciales de la aplicación y devolverá la respuesta real con citas
// agrupadas por fondo documental.

module.exports = {
  async contexto(ctx) {
    return ctx.send({
      es_prototipo: true,
      nota: 'Respuesta de demostración con datos del Fondo García Lorca.',
      respuesta:
        'En el Fondo García Lorca conservado en la Residencia de Estudiantes se encuentran materiales directamente relacionados con este período de producción. Destacan varios borradores manuscritos de poemas y textos en prosa fechados entre 1923 y 1928, así como correspondencia con Juan Ramón Jiménez y José Moreno Villa en la que Lorca comenta su actividad literaria durante su estancia en la Residencia. También se conservan fotografías de las tertulias en las que participó junto a Salvador Dalí y Luis Buñuel.',
      fondos: [
        {
          fondo: 'Fondo García Lorca',
          descripcion: 'Borradores manuscritos de poemas y textos en prosa',
          signatura: 'FGL/MAN/003/017',
          fecha: '1923-1928',
          url_atom: 'https://archivo.residencia.csic.es/atom/index.php/fgl-man-003-017',
        },
        {
          fondo: 'Fondo García Lorca',
          descripcion: 'Correspondencia con Juan Ramón Jiménez',
          signatura: 'FGL/COR/001/044',
          fecha: '1924-1929',
          url_atom: 'https://archivo.residencia.csic.es/atom/index.php/fgl-cor-001-044',
        },
        {
          fondo: 'Fondo Residencia de Estudiantes — Fotografías',
          descripcion: 'Fotografías de tertulias. Lorca, Dalí y Buñuel en la Residencia',
          signatura: 'RE/FOT/005/231',
          fecha: '1925',
          url_atom: 'https://archivo.residencia.csic.es/atom/index.php/re-fot-005-231',
        },
        {
          fondo: 'Fondo José Moreno Villa',
          descripcion: 'Correspondencia con García Lorca sobre actividad literaria',
          signatura: 'FMV/COR/002/088',
          fecha: '1926-1931',
          url_atom: 'https://archivo.residencia.csic.es/atom/index.php/fmv-cor-002-088',
        },
      ],
      confianza: 0.91,
    });
  },
};
