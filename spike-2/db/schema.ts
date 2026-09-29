import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Tabla desechable del spike. NO es el esquema de Mirada Larga (Plan §23:
// el modelo real solo se define tras validar la forma de los datos).
export const spikePing = pgTable("spike_ping", {
  id: integer("id").primaryKey(),
  nombre: text("nombre").notNull(),
  creadoEn: timestamp("creado_en", { withTimezone: true }).notNull().defaultNow(),
});
