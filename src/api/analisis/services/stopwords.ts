// Stopwords del español compartidas por los módulos de análisis léxico
// (TF-IDF en estilométrico/innovación, cadenas léxicas en bigramas):
// artículos, pronombres (personales, posesivos, demostrativos, relativos e
// indefinidos), preposiciones y conjunciones. Se excluyen porque son
// palabras gramaticales de uso casi universal sin valor estilístico propio.
export const STOPWORDS = new Set([
  // Artículos
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo',
  // Pronombres personales (sujeto, objeto, preposicionales)
  'yo', 'tú', 'tu', 'vos', 'él', 'ella', 'ello', 'nosotros', 'nosotras',
  'vosotros', 'vosotras', 'ellos', 'ellas', 'usted', 'ustedes', 'me', 'te',
  'se', 'nos', 'os', 'le', 'les', 'mí', 'ti', 'sí', 'conmigo', 'contigo',
  'consigo',
  // Pronombres y determinantes posesivos
  'mi', 'mis', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros',
  'nuestras', 'vuestro', 'vuestra', 'vuestros', 'vuestras', 'mío', 'mía',
  'míos', 'mías', 'tuyo', 'tuya', 'tuyos', 'tuyas', 'suyo', 'suya', 'suyos',
  'suyas',
  // Demostrativos
  'este', 'esta', 'estos', 'estas', 'esto', 'ese', 'esa', 'esos', 'esas',
  'eso', 'aquel', 'aquella', 'aquellos', 'aquellas', 'aquello',
  // Relativos e interrogativos (con y sin tilde: "que" relativo, "qué"
  // interrogativo/exclamativo)
  'que', 'qué', 'quien', 'quienes', 'quién', 'quiénes', 'cual', 'cuales',
  'cuál', 'cuáles', 'cuyo', 'cuya', 'cuyos', 'cuyas', 'donde', 'dónde',
  'cuando', 'cuándo', 'como', 'cómo', 'cuanto', 'cuanta', 'cuantos',
  'cuantas', 'cuánto', 'cuánta', 'cuántos', 'cuántas',
  // Indefinidos
  'alguien', 'algo', 'nadie', 'nada', 'alguno', 'alguna', 'algunos',
  'algunas', 'ninguno', 'ninguna', 'ningunos', 'ningunas', 'cualquier',
  'cualquiera', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros',
  'otras', 'mismo', 'misma', 'mismos', 'mismas', 'tal', 'tales', 'cada',
  'varios', 'varias', 'uno', 'unos', 'unas',
  // Preposiciones
  'a', 'ante', 'bajo', 'cabe', 'con', 'contra', 'de', 'desde', 'en',
  'entre', 'hacia', 'hasta', 'para', 'por', 'según', 'sin', 'sobre', 'tras',
  'durante', 'mediante', 'excepto', 'salvo', 'al', 'del',
  // Conjunciones y adverbios funcionales
  'y', 'e', 'ni', 'o', 'u', 'pero', 'mas', 'sino', 'aunque', 'porque',
  'pues', 'si', 'ya', 'muy', 'más', 'menos', 'también', 'tampoco', 'no',
  'tan', 'tanto', 'hay',
  // Formas de ser, estar y haber (verbos copulativos/auxiliares, sin valor
  // temático propio)
  'ser', 'soy', 'eres', 'es', 'somos', 'sois', 'son', 'era', 'eras', 'éramos',
  'eran', 'fui', 'fue', 'fuimos', 'fueron', 'seré', 'será', 'seremos',
  'serán', 'sea', 'seamos', 'sean', 'siendo', 'sido',
  'estar', 'estoy', 'estás', 'está', 'estamos', 'estáis', 'están', 'estaba',
  'estabas', 'estábamos', 'estaban', 'estuve', 'estuvo', 'estuvimos',
  'estuvieron', 'estaré', 'estará', 'estaremos', 'estarán', 'esté',
  'estemos', 'estén', 'estando', 'estado',
  'haber', 'he', 'has', 'ha', 'hemos', 'habéis', 'han', 'había', 'habías',
  'habíamos', 'habían', 'hube', 'hubo', 'hubimos', 'hubieron', 'habré',
  'habrá', 'habremos', 'habrán', 'haya', 'hayamos', 'hayan', 'habiendo',
  'habido',
]);
