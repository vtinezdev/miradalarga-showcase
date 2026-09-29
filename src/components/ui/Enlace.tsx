import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * Enlace interno. `next/link` para la navegación en cliente, pero **sin
 * precarga**: con `prefetch` cada enlace visible pediría su página al Worker, y
 * en el plan Free las invocaciones cuentan (ADR 0002). Se reevalúa midiendo.
 *
 * Los enlaces externos (plataformas) siguen siendo `<a>` corrientes.
 */
export function Enlace(props: ComponentProps<typeof Link>) {
  return <Link prefetch={false} {...props} />;
}
