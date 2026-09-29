/** Une clases condicionales: `cx(s.a, activo && s.b)`. */
export function cx(...clases: (string | false | null | undefined)[]): string {
  return clases.filter(Boolean).join(" ");
}
