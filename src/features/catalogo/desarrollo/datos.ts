/**
 * Datos de DESARROLLO. Ficticios de principio a fin: títulos, personas,
 * autores, veredictos, fechas y ofertas son inventados para diseñar y probar la
 * interfaz. **Nunca se publican** ni se mezclan con el catálogo real, y
 * desaparecen cuando `proveedor.ts` pase al adaptador de Neon.
 *
 * Cubren a propósito los casos que la interfaz tiene que resolver bien:
 * película y serie · suscripción, alquiler, compra, canal adicional · título
 * con imagen y sin ella · veredicto procedente de una lista y título sin
 * veredicto · título en dos listas · sinopsis larga · título muy largo · serie
 * sin sinopsis en español · título sin valoración · título sin disponibilidad
 * que salió del catálogo · llegada anunciada · precio desconocido · película sin
 * sinopsis · título en varias plataformas · plataformas con y sin capacidad de
 * salidas y llegadas anunciadas · lista larga (14) y corta (3) · lista con
 * introducción suficiente para indexarse y lista sin ella · los cinco tipos de
 * movimiento repartidos a ambos lados de hoy.
 *
 * Los enlaces a plataformas apuntan a su portada pública: son de ejemplo.
 */
import {
  type IdPlataformaPublica,
  PLATAFORMAS_PUBLICAS,
  plataformaPublica,
} from "../plataformas.ts";
import type {
  FichaDeTitulo,
  ListaEditorial,
  MatrizDeCapacidades,
  Movimiento,
  Plataforma,
} from "../modelo.ts";

export const ULTIMA_COMPROBACION = "2026-09-28T04:10:00Z";
export const INICIO_DEL_REGISTRO = "2026-09-01T00:00:00Z";

/**
 * Las plataformas salen de la presentación pública (`plataformas.ts`), la
 * misma que usa el adaptador de Neon: ids canónicos (`max`, nunca el `hbo`
 * del proveedor), nombres y slugs públicos. Los fixtures no inventan otros.
 */
const plataforma = (id: IdPlataformaPublica): Plataforma => {
  const p = plataformaPublica(id);
  if (!p) throw new Error(`Plataforma sin presentación: ${id}`);
  return p;
};

const P = {
  netflix: plataforma("netflix"),
  prime: plataforma("prime"),
  disney: plataforma("disney"),
  max: plataforma("max"),
  apple: plataforma("apple"),
  skyshowtime: plataforma("skyshowtime"),
} satisfies Record<IdPlataformaPublica, Plataforma>;

export const PLATAFORMAS: Plataforma[] = PLATAFORMAS_PUBLICAS.map((p) => P[p.id]);

const PORTADAS: Record<string, string> = {
  netflix: "https://www.netflix.com/es/",
  prime: "https://www.primevideo.com/",
  disney: "https://www.disneyplus.com/es-es",
  max: "https://www.hbomax.com/es/es",
  apple: "https://tv.apple.com/es",
  skyshowtime: "https://www.skyshowtime.com/es",
};

const enlace = (plataformaId: string): string =>
  PORTADAS[plataformaId] ?? "https://example.com/";

/** Matriz de `docs/DATA-SOURCES.md` §1.4, con sus cuatro estados. */
export const CAPACIDADES: MatrizDeCapacidades = {
  netflix: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "supported_with_data",
  },
  prime: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "supported_with_data",
    popularity_order: "unknown",
  },
  disney: {
    expiring: "supported_no_data_in_sample",
    upcoming: "supported_no_data_in_sample",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "unknown",
  },
  max: {
    expiring: "supported_with_data",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "not_supported",
    popularity_order: "unknown",
  },
  apple: {
    expiring: "supported_no_data_in_sample",
    upcoming: "supported_with_data",
    official_top: "supported_with_data",
    prices: "supported_with_data",
    popularity_order: "unknown",
  },
  skyshowtime: {
    expiring: "supported_with_data",
    upcoming: "not_supported",
    official_top: "supported_no_data_in_sample",
    prices: "not_supported",
    popularity_order: "unknown",
  },
};

const euros = (importe: number) => ({
  centimos: Math.round(importe * 100),
  moneda: "EUR" as const,
});

const FUENTE_VALORACION = "Streaming Availability";

/**
 * Registro de movimientos. Las fichas y el radar leen de aquí; ninguna de las
 * dos inventa los suyos.
 */
export const MOVIMIENTOS: Movimiento[] = [
  {
    tipo: "llega",
    tituloId: "t-cinco",
    plataforma: P.max,
    fecha: "2026-09-27T06:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-faro",
    plataforma: P.netflix,
    fecha: "2026-09-26T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-frontera",
    plataforma: P.apple,
    fecha: "2026-09-25T06:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-prestamo",
    plataforma: P.netflix,
    fecha: "2026-09-22T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-marea",
    plataforma: P.netflix,
    fecha: "2026-03-14T08:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-plomo",
    plataforma: P.max,
    fecha: "2025-11-02T08:00:00Z",
  },
  {
    tipo: "cambio",
    tituloId: "t-nada",
    plataforma: P.disney,
    fecha: "2026-09-25T09:00:00Z",
    detalle: "Ahora con audio en español",
  },
  {
    tipo: "se-fue",
    tituloId: "t-tren",
    plataforma: P.prime,
    fecha: "2026-09-20T00:00:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-ruido",
    plataforma: P.skyshowtime,
    fecha: "2026-10-05T21:59:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-marea",
    plataforma: P.netflix,
    fecha: "2026-10-09T21:59:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-cartas",
    plataforma: P.max,
    fecha: "2026-10-14T21:59:00Z",
  },
  {
    tipo: "proximamente",
    tituloId: "t-irene",
    plataforma: P.prime,
    fecha: "2026-10-03T07:00:00Z",
  },
  {
    tipo: "proximamente",
    tituloId: "t-eco",
    plataforma: P.netflix,
    fecha: "2026-10-10T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-alien",
    plataforma: P.prime,
    fecha: "2026-09-27T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-cumbre",
    plataforma: P.netflix,
    fecha: "2026-09-24T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-gaviotas",
    plataforma: P.disney,
    fecha: "2026-09-21T07:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-polar",
    plataforma: P.apple,
    fecha: "2026-09-18T06:00:00Z",
  },
  {
    tipo: "llega",
    tituloId: "t-silencio",
    plataforma: P.apple,
    fecha: "2026-09-16T06:00:00Z",
  },
  {
    tipo: "cambio",
    tituloId: "t-guardia",
    plataforma: P.netflix,
    fecha: "2026-09-26T09:00:00Z",
    detalle: "Ahora en 4K",
  },
  {
    tipo: "se-fue",
    tituloId: "t-sombra",
    plataforma: P.netflix,
    fecha: "2026-09-23T00:00:00Z",
  },
  {
    tipo: "se-fue",
    tituloId: "t-rio",
    plataforma: P.max,
    fecha: "2026-09-25T00:00:00Z",
  },
  {
    tipo: "se-fue",
    tituloId: "t-orilla",
    plataforma: P.prime,
    fecha: "2026-09-19T00:00:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-medianoche",
    plataforma: P.max,
    fecha: "2026-10-02T21:59:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-palabras",
    plataforma: P.netflix,
    fecha: "2026-10-03T21:59:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-verano",
    plataforma: P.skyshowtime,
    fecha: "2026-10-12T21:59:00Z",
  },
  {
    tipo: "se-va",
    tituloId: "t-caminos",
    plataforma: P.prime,
    fecha: "2026-10-20T21:59:00Z",
  },
  {
    tipo: "proximamente",
    tituloId: "t-herencia",
    plataforma: P.max,
    fecha: "2026-10-06T07:00:00Z",
  },
  {
    tipo: "proximamente",
    tituloId: "t-radio",
    plataforma: P.apple,
    fecha: "2026-10-15T07:00:00Z",
  },
];

type FichaSinDerivados = Omit<
  FichaDeTitulo,
  "disponibilidad" | "movimientos" | "comprobadoEn"
>;

export const FICHAS: FichaSinDerivados[] = [
  // ── Películas ──────────────────────────────────────────────────────────
  {
    id: "t-faro",
    slug: "la-casa-del-faro",
    tipo: "pelicula",
    titulo: "La casa del faro",
    anio: 2019,
    generos: ["Drama", "Thriller"],
    imagenes: {
      poster: { url: "/desarrollo/faro-poster.svg", ancho: 600, alto: 900 },
      fondo: { url: "/desarrollo/faro-fondo.svg", ancho: 1600, alto: 900 },
    },
    duracionMinutos: 118,
    sinopsis:
      "Tras la muerte de su padre, Elena vuelve a la isla gallega donde creció para vender el faro familiar. Un temporal la deja aislada con el último farero y con una carta que nadie debía encontrar.",
    direccion: ["Lucía Ferrán"],
    reparto: [
      "Elena Castro",
      "Julio Amenábar",
      "Nerea Soto",
      "Pau Ribas",
      "Lola Vidal",
      "Íñigo Garay",
      "Carmen Pardo",
    ],
    valoracion: { valor: 81, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "uhd",
        idiomas: { audio: ["español", "inglés"], subtitulos: ["español", "inglés"] },
        enlace: enlace("netflix"),
      },
      {
        plataforma: P.prime,
        tipo: "rent",
        precioDesde: euros(3.99),
        calidad: "hd",
        enlace: enlace("prime"),
      },
      {
        plataforma: P.prime,
        tipo: "buy",
        precioDesde: euros(9.99),
        calidad: "hd",
        enlace: enlace("prime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-cartas",
    slug: "todo-lo-que-no-nos-dijimos-el-invierno-en-que-dejamos-de-escribirnos-cartas",
    tipo: "pelicula",
    titulo:
      "Todo lo que no nos dijimos el invierno en que dejamos de escribirnos cartas",
    anio: 2023,
    generos: ["Drama", "Romance"],
    imagenes: {},
    duracionMinutos: 134,
    sinopsis: [
      "Durante veinte años, Clara y Tomás se escribieron una carta cada invierno. Nunca se llamaron, nunca se buscaron en redes y solo se vieron dos veces: una en una estación de Burgos y otra en un funeral que ninguno de los dos quiere recordar.",
      "El invierno en que la carta de Tomás no llega, Clara decide ir a buscarlo al pueblo del Pirineo desde el que siempre escribía. Allí descubre que él lleva años contando una versión de su vida que no coincide con la que ella conoce, y que las cartas guardaban más silencios que palabras.",
      "Rodada en tres inviernos consecutivos con el mismo reparto, la película alterna el presente con los fragmentos de las cartas leídas en voz alta, y se toma su tiempo para que cada reencuentro pese lo que tiene que pesar.",
    ].join("\n\n"),
    direccion: ["Andrés Pallarés"],
    reparto: [
      "Clara Montes",
      "Tomás Ibarra",
      "Aitana Rius",
      "Gonzalo Peña",
      "Marta Ledesma",
    ],
    valoracion: { valor: 74, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.max,
        tipo: "subscription",
        calidad: "hd",
        disponibleHasta: "2026-10-14T21:59:00Z",
        enlace: enlace("max"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-frontera",
    slug: "frontera-norte",
    tipo: "pelicula",
    titulo: "Frontera norte",
    anio: 2021,
    generos: ["Thriller", "Acción"],
    imagenes: {},
    duracionMinutos: 101,
    sinopsis:
      "Una inspectora de aduanas descubre que el camión que acaba de dejar pasar en Irún transportaba algo más que fruta. Tiene una noche para encontrarlo antes de que lo encuentren otros.",
    direccion: ["Lucía Ferrán"],
    reparto: ["Rocío Almagro", "Unai Etxebarria", "Samuel Oliva"],
    valoracion: { valor: 78, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.prime,
        tipo: "rent",
        precioDesde: euros(3.99),
        calidad: "hd",
        enlace: enlace("prime"),
      },
      {
        plataforma: P.prime,
        tipo: "buy",
        precioDesde: euros(12.99),
        calidad: "uhd",
        enlace: enlace("prime"),
      },
      {
        plataforma: P.apple,
        tipo: "rent",
        precioDesde: euros(4.99),
        enlace: enlace("apple"),
      },
      // Compra sin precio: el dato falta en ~50 % de las ofertas (§1.1).
      { plataforma: P.apple, tipo: "buy", enlace: enlace("apple") },
    ],
    anuncios: [],
  },
  {
    id: "t-luz",
    slug: "luz-de-agosto",
    tipo: "pelicula",
    titulo: "Luz de agosto",
    anio: 2018,
    generos: ["Comedia", "Familiar"],
    imagenes: {},
    duracionMinutos: 96,
    sinopsis:
      "Tres primos que no se soportan tienen que pasar el verano juntos en la casa de la abuela, en un pueblo de Teruel donde lo más emocionante es que se vaya la luz.",
    direccion: ["Rafael Nieto"],
    reparto: ["Pilar Garcés", "Hugo Serrano", "Leire Gil"],
    valoracion: { valor: 69, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.disney,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("disney"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-tren",
    slug: "el-ultimo-tren-a-soria",
    tipo: "pelicula",
    titulo: "El último tren a Soria",
    anio: 2016,
    generos: ["Drama"],
    imagenes: {},
    duracionMinutos: 109,
    sinopsis:
      "Un maquinista a punto de jubilarse hace su último recorrido en una línea que van a cerrar. Los viajeros de ese día tienen, cada uno, un motivo para no bajarse.",
    direccion: ["Andrés Pallarés"],
    reparto: ["Ramón Esteve", "Inés Calvo"],
    valoracion: { valor: 72, fuente: FUENTE_VALORACION },
    ofertas: [],
    anuncios: [],
  },
  {
    id: "t-ruido",
    slug: "ruido-blanco-en-la-sierra",
    tipo: "pelicula",
    titulo: "Ruido blanco en la sierra",
    anio: 2024,
    generos: ["Terror"],
    imagenes: {},
    duracionMinutos: 92,
    sinopsis:
      "Un equipo de radioaficionados capta una emisión que parece venir de un pueblo abandonado de la sierra de Gredos. Deciden ir a comprobarlo.",
    direccion: ["Nora Beltrán"],
    reparto: ["Alba Muñiz", "Carlos Duque"],
    // Sin valoración: el proveedor dio `rating: 0`, que es ausencia (§1.7).
    ofertas: [
      {
        plataforma: P.prime,
        tipo: "addon",
        addon: { id: "canalpanico", nombre: "Canal Pánico" },
        enlace: enlace("prime"),
      },
      {
        plataforma: P.skyshowtime,
        tipo: "subscription",
        disponibleHasta: "2026-10-05T21:59:00Z",
        enlace: enlace("skyshowtime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-prestamo",
    slug: "la-vida-en-prestamo",
    tipo: "pelicula",
    titulo: "La vida en préstamo",
    anio: 2022,
    generos: ["Comedia", "Drama"],
    imagenes: {},
    duracionMinutos: 105,
    sinopsis:
      "Una bibliotecaria de Zaragoza hereda por error la agenda de una desconocida y decide, durante una semana, vivir los planes que ella dejó escritos.",
    direccion: ["Sara Llorente"],
    reparto: ["Beatriz Olmo", "Diego Arranz", "Julia Sanz"],
    valoracion: { valor: 78, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("netflix"),
      },
      {
        plataforma: P.apple,
        tipo: "buy",
        precioDesde: euros(9.99),
        enlace: enlace("apple"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-norte",
    slug: "norte-magnetico",
    tipo: "pelicula",
    titulo: "Norte magnético",
    anio: 2020,
    generos: ["Ciencia ficción", "Drama"],
    imagenes: {},
    tituloOriginal: "Magnetic North",
    idiomaOriginal: "en",
    duracionMinutos: 124,
    sinopsis:
      "En una estación científica del Ártico, la brújula de todos los aparatos empieza a señalar hacia el mismo punto del hielo. La única geóloga que se queda a averiguar por qué no es la que menos tiene que perder.",
    direccion: ["Hanna Lindqvist"],
    reparto: ["Ingrid Moe", "Tom Hale", "Sanna Berg"],
    valoracion: { valor: 83, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.apple,
        tipo: "subscription",
        calidad: "uhd",
        enlace: enlace("apple"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-alien",
    slug: "los-alienigenas-de-tabernas",
    tipo: "pelicula",
    titulo: "Los alienígenas de Tabernas",
    anio: 2022,
    generos: ["Comedia", "Ciencia ficción"],
    imagenes: {},
    duracionMinutos: 99,
    sinopsis:
      "El rodaje de un wéstern de serie B en el desierto de Almería recibe la visita de unos extras que nadie ha contratado y que no parecen de este planeta.",
    direccion: ["Sara Llorente"],
    reparto: ["Antonio Reche", "Maribel Lozano", "Kevin Ortega"],
    valoracion: { valor: 67, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.prime,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("prime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-orilla",
    slug: "la-otra-orilla",
    tipo: "pelicula",
    titulo: "La otra orilla",
    anio: 2020,
    generos: ["Drama"],
    imagenes: {},
    duracionMinutos: 112,
    sinopsis:
      "Dos hermanas que no se hablan desde hace diez años comparten, por obligación, el último verano de la casa familiar en la ría de Arousa.",
    direccion: ["Marta Echeverri"],
    reparto: ["Olalla Pazos", "Carme Vilas", "Brais Otero"],
    valoracion: { valor: 77, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.disney,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("disney"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-medianoche",
    slug: "medianoche-en-el-mercado-central",
    tipo: "pelicula",
    titulo: "Medianoche en el mercado central",
    anio: 2017,
    generos: ["Thriller", "Policiaca"],
    imagenes: {},
    duracionMinutos: 104,
    sinopsis:
      "Un vigilante nocturno del mercado central de Valencia encuentra una caja fuerte abierta y a un hombre que dice ser el dueño. Hasta que amanezca, nadie puede salir.",
    direccion: ["Iván Rosales"],
    reparto: ["Jordi Albert", "Neus Ferrer"],
    valoracion: { valor: 75, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.max,
        tipo: "subscription",
        calidad: "hd",
        disponibleHasta: "2026-10-02T21:59:00Z",
        enlace: enlace("max"),
      },
      {
        plataforma: P.apple,
        tipo: "rent",
        precioDesde: euros(3.99),
        enlace: enlace("apple"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-cumbre",
    slug: "cumbre",
    tipo: "pelicula",
    titulo: "Cumbre",
    anio: 2023,
    generos: ["Aventura", "Drama"],
    imagenes: {},
    duracionMinutos: 97,
    sinopsis:
      "Una alpinista retirada acepta guiar a su hijo adolescente por la ruta en la que perdió a su compañero de cordada. Él no sabe nada de aquella noche.",
    direccion: ["Teresa Aldama"],
    reparto: ["Sonia Prieto", "Mateo Irala"],
    valoracion: { valor: 80, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "uhd",
        enlace: enlace("netflix"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-verano",
    slug: "el-verano-que-no-volvimos-a-cadiz",
    tipo: "pelicula",
    titulo: "El verano que no volvimos a Cádiz",
    anio: 2019,
    generos: ["Comedia", "Drama"],
    imagenes: {},
    duracionMinutos: 101,
    sinopsis:
      "Cuatro amigos de la facultad intentan repetir, veinte años después, el viaje que les cambió la vida. El coche es el mismo; ellos, no.",
    direccion: ["Pablo Quintero"],
    reparto: ["Rocío Almagro", "Diego Arranz", "Paco Soler", "Julia Sanz"],
    valoracion: { valor: 70, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.skyshowtime,
        tipo: "subscription",
        disponibleHasta: "2026-10-12T21:59:00Z",
        enlace: enlace("skyshowtime"),
      },
      // Compra sin precio conocido.
      { plataforma: P.prime, tipo: "buy", enlace: enlace("prime") },
    ],
    anuncios: [],
  },
  {
    id: "t-silencio",
    slug: "silencio-en-la-sala-4",
    tipo: "pelicula",
    titulo: "Silencio en la sala 4",
    anio: 2021,
    generos: ["Thriller"],
    imagenes: {},
    duracionMinutos: 95,
    // Película sin sinopsis en español (§1.2).
    direccion: ["Nora Beltrán"],
    reparto: ["Alba Muñiz", "Samuel Oliva"],
    valoracion: { valor: 80, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.apple,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("apple"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-sombra",
    slug: "la-sombra-del-alcalde",
    tipo: "pelicula",
    titulo: "La sombra del alcalde",
    anio: 2015,
    generos: ["Drama"],
    imagenes: {},
    duracionMinutos: 121,
    sinopsis:
      "El jefe de prensa de un alcalde de provincias descubre que su trabajo consiste, sobre todo, en que nadie haga preguntas. Hasta que le toca hacerlas a él.",
    direccion: ["Andrés Pallarés"],
    reparto: ["Ramón Esteve", "Beatriz Olmo"],
    valoracion: { valor: 76, fuente: FUENTE_VALORACION },
    // Salió de Netflix el 23 sep: hoy no está en ninguna plataforma.
    ofertas: [],
    anuncios: [],
  },

  // ── Series ─────────────────────────────────────────────────────────────
  {
    id: "t-plomo",
    slug: "los-anos-de-plomo",
    tipo: "serie",
    titulo: "Los años de plomo",
    anio: 2016,
    anioFin: 2022,
    generos: ["Drama", "Historia"],
    imagenes: {
      poster: { url: "/desarrollo/plomo-poster.svg", ancho: 600, alto: 900 },
      fondo: { url: "/desarrollo/plomo-fondo.svg", ancho: 1600, alto: 900 },
    },
    temporadas: 3,
    episodios: 24,
    sinopsis:
      "Bilbao, 1979. Una periodista recién llegada a la redacción de un diario local empieza a tirar del hilo de una desaparición que todos prefieren olvidar. Tres temporadas, tres décadas y una misma pregunta.",
    direccion: ["Marta Echeverri"],
    reparto: [
      "Itziar Goñi",
      "Álvaro Lasa",
      "Ane Zubiri",
      "Félix Urrutia",
      "Rosa Azcona",
      "Mikel Oyarzun",
    ],
    valoracion: { valor: 88, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.max,
        tipo: "subscription",
        calidad: "uhd",
        idiomas: { audio: ["español", "euskera"], subtitulos: ["español", "inglés"] },
        enlace: enlace("max"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-marea",
    slug: "marea-baja",
    tipo: "serie",
    titulo: "Marea baja",
    anio: 2024,
    generos: ["Thriller", "Drama"],
    imagenes: {},
    temporadas: 1,
    episodios: 6,
    sinopsis:
      "En un pueblo de la costa de Cádiz, la marea más baja en cincuenta años deja al descubierto un coche hundido. Dentro no hay nadie, y eso es lo que más preocupa a la sargento Reyes.",
    direccion: ["Pablo Quintero"],
    reparto: ["Macarena Reyes", "Joaquín Doblas", "Ángela Mora"],
    valoracion: { valor: 79, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "hd",
        disponibleHasta: "2026-10-09T21:59:00Z",
        enlace: enlace("netflix"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-distrito",
    slug: "distrito-once",
    tipo: "serie",
    titulo: "Distrito Once",
    anio: 2020,
    anioFin: 2023,
    generos: ["Policiaca"],
    imagenes: {},
    temporadas: 4,
    episodios: 40,
    // Sin sinopsis en español: hueco de traducción del proveedor (§1.2).
    direccion: ["Iván Rosales"],
    reparto: ["Óscar Lamas", "Nuria Vela"],
    valoracion: { valor: 71, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.skyshowtime,
        tipo: "subscription",
        enlace: enlace("skyshowtime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-irene",
    slug: "la-cocina-de-irene",
    tipo: "serie",
    titulo: "La cocina de Irene",
    anio: 2025,
    generos: ["Comedia"],
    imagenes: {},
    temporadas: 1,
    episodios: 8,
    sinopsis:
      "Irene reabre el bar de su madre en un barrio de Valencia que ya no es el que era. Cada episodio, un plato y una discusión con alguien que no quiere que el barrio cambie, o que no quiere que siga igual.",
    direccion: ["Clara Vives"],
    reparto: ["Irene Martí", "Paco Soler", "Lucía Ferrer"],
    valoracion: { valor: 76, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.apple,
        tipo: "subscription",
        calidad: "uhd",
        enlace: enlace("apple"),
      },
    ],
    anuncios: [
      { plataforma: P.prime, tipo: "subscription", fecha: "2026-10-03T07:00:00Z" },
    ],
  },
  {
    id: "t-cinco",
    slug: "cinco-noches",
    tipo: "serie",
    titulo: "Cinco noches",
    anio: 2024,
    generos: ["Drama"],
    imagenes: {},
    temporadas: 1,
    episodios: 5,
    sinopsis:
      "Cinco episodios, cinco noches en la vida de una enfermera de urgencias de Madrid durante la peor ola de calor que recuerda la ciudad.",
    direccion: ["Teresa Aldama"],
    reparto: ["Sonia Prieto", "Raúl Cebrián"],
    valoracion: { valor: 84, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("netflix"),
      },
      { plataforma: P.max, tipo: "subscription", calidad: "hd", enlace: enlace("max") },
    ],
    anuncios: [],
  },
  {
    id: "t-nada",
    slug: "aqui-no-pasa-nada",
    tipo: "serie",
    titulo: "Aquí no pasa nada",
    anio: 2023,
    generos: ["Comedia", "Familiar"],
    imagenes: {},
    temporadas: 2,
    episodios: 16,
    sinopsis:
      "Una familia de Albacete gana un concurso de la tele y el premio es que las cámaras se instalen en su casa un año. No pasa nada, y eso es lo mejor que les podía pasar.",
    direccion: ["Jorge Albiol"],
    reparto: ["Maite Cano", "Ernesto Gil", "Vera Cano"],
    valoracion: { valor: 73, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.disney,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("disney"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-eco",
    slug: "el-eco",
    tipo: "serie",
    titulo: "El eco",
    anio: 2026,
    generos: ["Thriller"],
    imagenes: {},
    temporadas: 1,
    episodios: 8,
    sinopsis:
      "Una ingeniera de sonido encuentra en unas grabaciones de campo una voz que no debería estar ahí.",
    direccion: ["Nora Beltrán"],
    reparto: ["Laia Puig", "Andrés Toledo"],
    // Sin valoración todavía: es un estreno.
    ofertas: [],
    anuncios: [
      { plataforma: P.netflix, tipo: "subscription", fecha: "2026-10-10T07:00:00Z" },
    ],
  },
  {
    id: "t-guardia",
    slug: "guardia-de-noche",
    tipo: "serie",
    titulo: "Guardia de noche",
    anio: 2021,
    anioFin: 2023,
    generos: ["Policiaca", "Drama"],
    imagenes: {},
    temporadas: 3,
    episodios: 30,
    sinopsis:
      "Tres temporadas en el turno de noche de una comisaría de Vigo, donde los casos llegan de madrugada y casi nunca se cierran antes del amanecer.",
    direccion: ["Iván Rosales"],
    reparto: ["Óscar Lamas", "Uxía Blanco", "Nuria Vela"],
    valoracion: { valor: 82, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "uhd",
        enlace: enlace("netflix"),
      },
      {
        plataforma: P.skyshowtime,
        tipo: "subscription",
        enlace: enlace("skyshowtime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-gaviotas",
    slug: "el-colegio-de-las-gaviotas",
    tipo: "serie",
    titulo: "El colegio de las gaviotas",
    anio: 2025,
    generos: ["Comedia", "Familiar"],
    imagenes: {},
    temporadas: 1,
    episodios: 10,
    sinopsis:
      "El único colegio de una isla canaria tiene once alumnos, una maestra recién llegada de Madrid y un problema: el año que viene quieren cerrarlo.",
    direccion: ["Clara Vives"],
    reparto: ["Irene Martí", "Yeray Santana"],
    valoracion: { valor: 74, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.disney,
        tipo: "subscription",
        calidad: "hd",
        enlace: enlace("disney"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-polar",
    slug: "estacion-polar",
    tipo: "serie",
    titulo: "Estación Polar",
    anio: 2024,
    generos: ["Ciencia ficción", "Drama"],
    imagenes: {},
    temporadas: 2,
    episodios: 16,
    sinopsis:
      "El relevo de invierno de una base antártica española llega y encuentra la base vacía, la cena servida y el diario de a bordo arrancado desde marzo.",
    direccion: ["Hanna Lindqvist"],
    reparto: ["Ingrid Moe", "Álvaro Lasa"],
    valoracion: { valor: 85, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.apple,
        tipo: "subscription",
        calidad: "uhd",
        enlace: enlace("apple"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-herencia",
    slug: "la-herencia-de-los-urquiza",
    tipo: "serie",
    titulo: "La herencia de los Urquiza",
    anio: 2026,
    generos: ["Drama"],
    imagenes: {},
    temporadas: 1,
    episodios: 8,
    sinopsis:
      "La muerte del patriarca de una familia de bodegueros riojanos deja un testamento que nadie esperaba y una hija de la que nadie había oído hablar.",
    direccion: ["Marta Echeverri"],
    reparto: ["Rosa Azcona", "Félix Urrutia"],
    // Estreno anunciado: sin valoración ni ofertas todavía.
    ofertas: [],
    anuncios: [
      { plataforma: P.max, tipo: "subscription", fecha: "2026-10-06T07:00:00Z" },
    ],
  },
  {
    id: "t-caminos",
    slug: "mapa-de-los-caminos-secundarios",
    tipo: "serie",
    titulo: "Mapa de los caminos secundarios",
    anio: 2019,
    anioFin: 2020,
    generos: ["Documental"],
    imagenes: {},
    temporadas: 2,
    episodios: 12,
    sinopsis:
      "Un cartógrafo jubilado recorre España solo por carreteras comarcales. Cada episodio, una comarca y alguien que se quedó cuando todos se fueron.",
    direccion: ["Rafael Nieto"],
    reparto: ["Ernesto Gil"],
    valoracion: { valor: 79, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.prime,
        tipo: "subscription",
        calidad: "hd",
        disponibleHasta: "2026-10-20T21:59:00Z",
        enlace: enlace("prime"),
      },
      { plataforma: P.max, tipo: "subscription", calidad: "hd", enlace: enlace("max") },
    ],
    anuncios: [],
  },
  {
    id: "t-rio",
    slug: "rio-abajo",
    tipo: "serie",
    titulo: "Río abajo",
    anio: 2023,
    generos: ["Thriller"],
    imagenes: {},
    temporadas: 1,
    episodios: 6,
    sinopsis:
      "Una piragüista encuentra una mochila con dinero en el Sella la semana del descenso internacional. Devolverla resulta más peligroso que quedársela.",
    direccion: ["Pablo Quintero"],
    reparto: ["Leire Gil", "Hugo Serrano"],
    valoracion: { valor: 72, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.skyshowtime,
        tipo: "subscription",
        enlace: enlace("skyshowtime"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-palabras",
    slug: "palabras-cruzadas",
    tipo: "serie",
    titulo: "Palabras cruzadas",
    anio: 2022,
    generos: ["Comedia"],
    imagenes: {},
    temporadas: 2,
    episodios: 20,
    sinopsis:
      "La redacción de pasatiempos de un periódico en crisis se entera de que va a desaparecer y decide esconder en los crucigramas todo lo que nunca se atrevió a publicar.",
    direccion: ["Jorge Albiol"],
    reparto: ["Maite Cano", "Gonzalo Peña"],
    valoracion: { valor: 71, fuente: FUENTE_VALORACION },
    ofertas: [
      {
        plataforma: P.netflix,
        tipo: "subscription",
        calidad: "hd",
        disponibleHasta: "2026-10-03T21:59:00Z",
        enlace: enlace("netflix"),
      },
    ],
    anuncios: [],
  },
  {
    id: "t-radio",
    slug: "los-dias-de-radio",
    tipo: "serie",
    titulo: "Los días de radio",
    anio: 2026,
    generos: ["Comedia", "Drama"],
    imagenes: {},
    temporadas: 1,
    // Estreno anunciado, sin sinopsis en español todavía.
    direccion: ["Sara Llorente"],
    reparto: ["Beatriz Olmo", "Raúl Cebrián"],
    ofertas: [],
    anuncios: [
      { plataforma: P.apple, tipo: "subscription", fecha: "2026-10-15T07:00:00Z" },
    ],
  },
];

const ANA = { nombre: "Ana Ruiz", slug: "ana-ruiz" };
const MARCOS = { nombre: "Marcos Vidal", slug: "marcos-vidal" };
const LUCIA = { nombre: "Lucía Prats", slug: "lucia-prats" };

export const LISTA_DESTACADA_ID = "l-fin-de-semana";

export const LISTAS: ListaEditorial[] = [
  {
    id: "l-fin-de-semana",
    slug: "series-cortas-para-un-fin-de-semana",
    titulo: "Series cortas para un fin de semana",
    entradilla:
      "Cuatro historias que empiezan y acaban en dos noches, sin temporadas pendientes.",
    autor: ANA,
    publicada: "2026-09-12T08:00:00Z",
    revisada: "2026-09-27T08:00:00Z",
    // Introducción breve: por debajo de las 120 palabras del checklist de landing.
    introduccion:
      "Hay fines de semana que piden algo con principio y final. Estas cuatro series se ven en dos noches, no dejan temporadas pendientes y ninguna termina con un gancho pensado para retenerte.",
    criterio:
      "Series de una o dos temporadas cortas, cerradas en sí mismas y disponibles hoy en al menos una plataforma de suscripción.",
    entradas: [
      {
        orden: 1,
        tituloId: "t-cinco",
        etiqueta: "Imprescindible",
        veredicto:
          "Cinco noches de guardia contadas casi en tiempo real, sin subrayar nada. Funciona si te gusta el drama contenido y de personajes; si buscas giros, no es para ti.",
      },
      {
        orden: 2,
        tituloId: "t-marea",
        etiqueta: "Ideal para un fin de semana",
        veredicto:
          "Un misterio costero de seis episodios que se resuelve sin trampas. Directa y adictiva; no esperes que reinvente el género.",
      },
      {
        orden: 3,
        tituloId: "t-irene",
        etiqueta: "Fácil de ver",
        veredicto:
          "Comedia de barrio con buen oído para los diálogos y episodios de media hora. Perfecta para bajar el ritmo; si odias la comedia costumbrista, sáltatela.",
      },
      {
        orden: 4,
        tituloId: "t-nada",
        veredicto:
          "Dos temporadas cortas de una familia que no hace nada extraordinario, y ahí está la gracia. Para quien disfruta con lo cotidiano; a quien necesite trama le parecerá lenta.",
      },
    ],
  },
  {
    id: "l-otono",
    slug: "catorce-titulos-para-las-noches-de-otono",
    titulo: "Catorce títulos para las noches de otoño",
    entradilla:
      "Películas y series que piden sofá, manta y atención: ninguna se ve con el móvil en la mano.",
    autor: LUCIA,
    publicada: "2026-09-01T08:00:00Z",
    revisada: "2026-09-26T08:00:00Z",
    introduccion: [
      "El otoño es la estación en la que más horas pasamos delante de una pantalla y, curiosamente, en la que menos paciencia tenemos para elegir. Esta lista existe para ahorrarte la media hora de recorrer menús: catorce títulos, entre películas y series, que tienen en común algo más difícil de encontrar que un buen argumento, y es que piden atención y la devuelven con creces.",
      "No hay aquí estrenos de relleno ni títulos elegidos por estar de moda. Hay thrillers de atmósfera, dramas familiares, ciencia ficción contenida y un documental que se ve como una novela de carretera. Algunos son largos y otros se ven en una tarde; en cada entrada te decimos para quién es y, sobre todo, para quién no.",
      "La revisamos cada semana. Si un título deja de estar en las plataformas que seguimos, no lo quitamos en silencio: lo verás atenuado, con la fecha en que salió, hasta que decidamos sustituirlo.",
    ].join("\n\n"),
    criterio:
      "Títulos disponibles en España en al menos una de las seis plataformas que seguimos, vistos enteros por quien firma la lista y elegidos por su capacidad de sostener una noche entera. Ninguno entra por su valoración externa ni por su popularidad.",
    entradas: [
      {
        orden: 1,
        tituloId: "t-polar",
        etiqueta: "Imprescindible",
        veredicto:
          "Ciencia ficción sin naves ni láseres: aislamiento, frío y un misterio que se resuelve sin trampas. Si te gustan las historias de lugares cerrados, no hay mejor plan para octubre.",
      },
      {
        orden: 2,
        tituloId: "t-faro",
        etiqueta: "Joya escondida",
        veredicto:
          "Temporal, faro y una carta escondida: el otoño hecho película. Pide paciencia en la primera media hora.",
      },
      {
        orden: 3,
        tituloId: "t-guardia",
        veredicto:
          "Policiaca de turno de noche con personajes que envejecen de verdad entre temporadas. Tres temporadas que se sostienen de principio a fin.",
      },
      {
        orden: 4,
        tituloId: "t-norte",
        etiqueta: "Exigente",
        veredicto:
          "Una película de ideas que no las subraya. Si buscas respuestas cerradas, te frustrará; si te gusta pensar después, te acompañará días.",
      },
      {
        orden: 5,
        tituloId: "t-orilla",
        veredicto:
          "Un drama de hermanas contado con una contención admirable. Pequeña, precisa y muy bien interpretada.",
      },
      {
        orden: 6,
        tituloId: "t-cumbre",
        etiqueta: "Gran espectáculo",
        veredicto:
          "Montaña de verdad, rodada sin trucos, al servicio de una historia de madre e hijo. Mejor en la pantalla más grande que tengas.",
      },
      {
        orden: 7,
        tituloId: "t-silencio",
        veredicto:
          "Un thriller judicial que pasa casi entero en una sala. Tenso y bien escrito, aunque el último giro se ve venir.",
      },
      {
        orden: 8,
        tituloId: "t-sombra",
        veredicto:
          "Una película política sin discursos, sobre la comodidad de no preguntar. De lo mejor del cine español de su año.",
      },
      {
        orden: 9,
        tituloId: "t-caminos",
        etiqueta: "Ritmo lento",
        veredicto:
          "Un documental que se ve como una novela de carretera. Episodios sueltos: ideal para una noche en la que no quieras engancharte a nada.",
      },
      {
        orden: 10,
        tituloId: "t-medianoche",
        veredicto:
          "Una noche, un mercado cerrado y dos desconocidos. Serie B en el mejor sentido: breve, ingeniosa y sin una escena de sobra.",
      },
      {
        orden: 11,
        tituloId: "t-plomo",
        veredicto:
          "Para las semanas largas de noviembre: tres temporadas de periodismo e investigación con una reconstrucción de época impecable.",
      },
      {
        orden: 12,
        tituloId: "t-verano",
        veredicto:
          "Una comedia agridulce de amigos que ya no tienen veinte años. Mejor de lo que su título promete, aunque el último tramo se alarga.",
      },
      {
        orden: 13,
        tituloId: "t-prestamo",
        veredicto:
          "El respiro de la lista: una comedia amable para la noche en que no quieras sufrir.",
      },
      {
        orden: 14,
        tituloId: "t-rio",
        veredicto:
          "Seis episodios de thriller fluvial que se ven de una sentada. Nada nuevo, todo bien hecho.",
      },
    ],
  },
  {
    id: "l-thrillers",
    slug: "thrillers-que-no-te-dejan-levantarte-del-sofa",
    titulo: "Thrillers que no te dejan levantarte del sofá",
    entradilla: "Tensión bien administrada, sin sustos baratos ni finales tramposos.",
    autor: MARCOS,
    publicada: "2026-09-05T08:00:00Z",
    revisada: "2026-09-24T08:00:00Z",
    entradas: [
      {
        orden: 1,
        tituloId: "t-marea",
        veredicto:
          "No reinventa el thriller, pero ejecuta su propuesta con muchísimo ritmo y una tensión que apenas decae. Especialmente recomendable si buscas algo directo para una noche.",
      },
      {
        orden: 2,
        tituloId: "t-faro",
        etiqueta: "Joya escondida",
        veredicto:
          "Un thriller de atmósfera que se cuece a fuego lento en una isla aislada por el temporal. Pide paciencia en la primera media hora; quien la tenga, la agradecerá.",
      },
      {
        orden: 3,
        tituloId: "t-plomo",
        etiqueta: "Exigente",
        veredicto:
          "Tres temporadas de periodismo e investigación con una reconstrucción de época impecable. Densa y larga: para quien quiera algo en lo que meterse durante semanas.",
      },
    ],
  },
  {
    id: "l-familia",
    slug: "para-ver-en-familia-sin-que-nadie-se-aburra",
    titulo: "Para ver en familia sin que nadie se aburra",
    entradilla: "Títulos que funcionan igual con doce años que con cincuenta.",
    autor: ANA,
    publicada: "2026-08-30T08:00:00Z",
    revisada: "2026-09-20T08:00:00Z",
    entradas: [
      {
        orden: 1,
        tituloId: "t-luz",
        veredicto:
          "Una comedia veraniega sin cinismo, con niños que hablan como niños. Ideal para un domingo; los adolescentes más escépticos la verán con desdén.",
      },
      {
        orden: 2,
        tituloId: "t-nada",
        veredicto:
          "Humor blanco que no trata al espectador de tonto. Funciona a cualquier edad; no esperes carcajadas, sino sonrisas constantes.",
      },
      {
        orden: 3,
        tituloId: "t-prestamo",
        veredicto:
          "Una comedia amable sobre atreverse a cambiar de vida. Para toda la familia a partir de la adolescencia; algún tramo se alarga.",
      },
    ],
  },
  {
    id: "l-cine-espanol",
    slug: "cine-espanol-reciente-que-se-te-pudo-escapar",
    titulo: "Cine español reciente que se te pudo escapar",
    entradilla:
      "Películas que pasaron por salas casi sin ruido y merecen una segunda oportunidad en casa.",
    autor: MARCOS,
    publicada: "2026-08-20T08:00:00Z",
    revisada: "2026-09-15T08:00:00Z",
    entradas: [
      {
        orden: 1,
        tituloId: "t-cartas",
        etiqueta: "Ritmo lento",
        veredicto:
          "Un melodrama epistolar que no tiene prisa y lo sabe. Si te dejas llevar, es de las que se quedan; si necesitas acción, dos horas y cuarto se te harán muy largas.",
      },
      {
        orden: 2,
        tituloId: "t-tren",
        veredicto:
          "Una película coral pequeña y precisa sobre el final de una línea de tren. Para quien disfruta de las historias mínimas.",
      },
      {
        orden: 3,
        tituloId: "t-luz",
        veredicto:
          "Comedia rural sin condescendencia, con un reparto infantil sorprendente. Ligera, pero no tonta.",
      },
    ],
  },
];
