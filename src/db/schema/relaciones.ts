/**
 * Relaciones de Drizzle.
 *
 * **No generan una sola línea de SQL**: son metadatos para la API relacional
 * (`db.query.x.findMany({ with: … })`), que es el camino de lectura idiomático
 * que usará `src/db/queries/` en la Fase 2.
 *
 * El grafo real no es trivial —título → oferta lógica → opciones → eventos— y
 * declararlo aquí evita que cada consulta futura lo reconstruya a mano con
 * `join`.
 */
import { relations } from "drizzle-orm";

import {
  externalGenres,
  externalTitleGenres,
  externalTitleImages,
  externalTitles,
} from "./catalogo.ts";
import {
  externalAvailability,
  externalAvailabilityAnnouncements,
  externalAvailabilityEvents,
  externalAvailabilityOptions,
  externalPlatformCapabilities,
  externalPlatforms,
} from "./disponibilidad.ts";
import { derivedRankingDefinitions, derivedRankingEntries } from "./derivado.ts";
import { externalListCaptures, externalListPositions } from "./senales.ts";

export const relacionesTitulos = relations(externalTitles, ({ many }) => ({
  generos: many(externalTitleGenres),
  imagenes: many(externalTitleImages),
  disponibilidad: many(externalAvailability),
  anuncios: many(externalAvailabilityAnnouncements),
  posiciones: many(externalListPositions),
  entradasDeRanking: many(derivedRankingEntries),
}));

export const relacionesGeneros = relations(externalGenres, ({ many }) => ({
  titulos: many(externalTitleGenres),
}));

export const relacionesTitulosGeneros = relations(externalTitleGenres, ({ one }) => ({
  titulo: one(externalTitles, {
    fields: [externalTitleGenres.titleId],
    references: [externalTitles.id],
  }),
  genero: one(externalGenres, {
    fields: [externalTitleGenres.genreId],
    references: [externalGenres.id],
  }),
}));

export const relacionesImagenes = relations(externalTitleImages, ({ one }) => ({
  titulo: one(externalTitles, {
    fields: [externalTitleImages.titleId],
    references: [externalTitles.id],
  }),
}));

export const relacionesPlataformas = relations(externalPlatforms, ({ many }) => ({
  capacidades: many(externalPlatformCapabilities),
  disponibilidad: many(externalAvailability),
  anuncios: many(externalAvailabilityAnnouncements),
  capturas: many(externalListCaptures),
}));

export const relacionesCapacidades = relations(
  externalPlatformCapabilities,
  ({ one }) => ({
    plataforma: one(externalPlatforms, {
      fields: [externalPlatformCapabilities.platformId],
      references: [externalPlatforms.id],
    }),
  }),
);

export const relacionesDisponibilidad = relations(
  externalAvailability,
  ({ one, many }) => ({
    titulo: one(externalTitles, {
      fields: [externalAvailability.titleId],
      references: [externalTitles.id],
    }),
    plataforma: one(externalPlatforms, {
      fields: [externalAvailability.platformId],
      references: [externalPlatforms.id],
    }),
    opciones: many(externalAvailabilityOptions),
    eventos: many(externalAvailabilityEvents),
  }),
);

export const relacionesOpciones = relations(externalAvailabilityOptions, ({ one }) => ({
  oferta: one(externalAvailability, {
    fields: [externalAvailabilityOptions.availabilityId],
    references: [externalAvailability.id],
  }),
}));

export const relacionesEventos = relations(externalAvailabilityEvents, ({ one }) => ({
  oferta: one(externalAvailability, {
    fields: [externalAvailabilityEvents.availabilityId],
    references: [externalAvailability.id],
  }),
}));

export const relacionesAnuncios = relations(
  externalAvailabilityAnnouncements,
  ({ one }) => ({
    titulo: one(externalTitles, {
      fields: [externalAvailabilityAnnouncements.titleId],
      references: [externalTitles.id],
    }),
    plataforma: one(externalPlatforms, {
      fields: [externalAvailabilityAnnouncements.platformId],
      references: [externalPlatforms.id],
    }),
  }),
);

export const relacionesCapturas = relations(externalListCaptures, ({ one, many }) => ({
  plataforma: one(externalPlatforms, {
    fields: [externalListCaptures.platformId],
    references: [externalPlatforms.id],
  }),
  posiciones: many(externalListPositions),
}));

export const relacionesPosiciones = relations(externalListPositions, ({ one }) => ({
  captura: one(externalListCaptures, {
    fields: [externalListPositions.captureId],
    references: [externalListCaptures.id],
  }),
  titulo: one(externalTitles, {
    fields: [externalListPositions.titleId],
    references: [externalTitles.id],
  }),
}));

export const relacionesDefiniciones = relations(
  derivedRankingDefinitions,
  ({ many }) => ({
    entradas: many(derivedRankingEntries),
  }),
);

export const relacionesEntradas = relations(derivedRankingEntries, ({ one }) => ({
  definicion: one(derivedRankingDefinitions, {
    fields: [derivedRankingEntries.rankingId],
    references: [derivedRankingDefinitions.id],
  }),
  titulo: one(externalTitles, {
    fields: [derivedRankingEntries.titleId],
    references: [externalTitles.id],
  }),
}));
