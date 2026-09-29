-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  MIGRACIÓN MANUAL. Drizzle no modela triggers: este fichero está escrito  ║
-- ║  a mano y drizzle-kit NO lo ve en sus snapshots. Un `generate` posterior  ║
-- ║  no lo tocará, pero tampoco detectará si alguien lo borra de la base de   ║
-- ║  datos. Lo vigila `tests/contract/migracion-inicial.test.ts`.             ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Invariante 8 de docs/DATA-MODEL.md: el histórico no se reescribe.
--
-- Los privilegios no frenan al propietario de la tabla, así que la prohibición
-- se impone también con un trigger.
--
-- ⚠️ CORRECCIÓN DEL DISEÑO CONGELADO, deliberada y aprobada.
--
-- El documento pedía `BEFORE UPDATE OR DELETE` en las TRES tablas de histórico.
-- Eso es incompatible con su propia política de retención, que da 180 días a
-- `external_list_captures` y `external_list_positions`: un trigger que prohíbe
-- DELETE hace imposible ejecutar esa retención.
--
-- Lo que el append-only protege de verdad es que nadie **reescriba** lo que
-- dijimos haber observado, y eso es UPDATE. El DELETE de capturas y posiciones
-- no es una violación del histórico: es una política documentada, con horizonte
-- y motivo. Son dos cosas distintas que el invariante había fundido en una.
--
-- Por eso los triggers son asimétricos:
--
--   external_availability_events   UPDATE ❌   DELETE ❌
--       «se compacta, no se borra». Es diferencial de producto.
--
--   external_list_captures         UPDATE ❌   DELETE ✅ (retención)
--   external_list_positions        UPDATE ❌   DELETE ✅ (retención)
--
-- Los 180 días NO se codifican aquí: clavar el horizonte en el esquema antes de
-- que exista el job de retención convertiría cada cambio de política en una
-- migración. Lo cubre la capa 1 del invariante 8 — el rol de ingesta recibe
-- INSERT y SELECT, y nada más — y el rol de retención, cuando exista.
--
-- `external_list_positions.capture_id` es RESTRICT y no CASCADE justamente para
-- que la retención borre en dos pasos explícitos, primero posiciones y luego
-- capturas, sin depender del comportamiento de un trigger dentro de una cascada.
--
-- Coste conocido: la compactación futura de eventos exigirá una migración que
-- retire y reponga su trigger.

CREATE OR REPLACE FUNCTION raise_immutable_history() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'La tabla % es histórico inmutable: % no está permitido.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER external_availability_events_immutable
  BEFORE UPDATE OR DELETE ON external_availability_events
  FOR EACH ROW EXECUTE FUNCTION raise_immutable_history();
--> statement-breakpoint
CREATE TRIGGER external_list_captures_immutable
  BEFORE UPDATE ON external_list_captures
  FOR EACH ROW EXECUTE FUNCTION raise_immutable_history();
--> statement-breakpoint
CREATE TRIGGER external_list_positions_immutable
  BEFORE UPDATE ON external_list_positions
  FOR EACH ROW EXECUTE FUNCTION raise_immutable_history();
