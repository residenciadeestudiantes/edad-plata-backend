const { compileStrapi, createStrapi } = require('@strapi/strapi');

// Coordenadas del segundo lugar de publicación de tres revistas.
// Santander, Sevilla y París según datos introducidos en el admin.
const ACTUALIZACIONES = [
  { documentId: 'nsy33x5boahgm81vk3l2n4vc', titulo: 'Carmen',            latitud_2: 43.4628, longitud_2: -3.8099 },
  { documentId: 'tum8hmv3fjsf59fnq25vwezh', titulo: 'Papel de Aleluyas', latitud_2: 37.3891, longitud_2: -5.9845 },
  { documentId: 'luzozv0v5hmulwk8rvg0erkc', titulo: 'Poesía',            latitud_2: 48.8566, longitud_2:  2.3522 },
];

async function main() {
  await compileStrapi();
  const app = await createStrapi().load();

  for (const { documentId, titulo, latitud_2, longitud_2 } of ACTUALIZACIONES) {
    await app.documents('api::publication.publication').update({
      documentId,
      data: { latitud_2, longitud_2 },
    });
    console.log(`✔ ${titulo} → latitud_2=${latitud_2}, longitud_2=${longitud_2}`);
  }

  await app.destroy();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
