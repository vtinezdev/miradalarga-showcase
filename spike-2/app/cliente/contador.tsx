"use client";

import { useState } from "react";

// Unico Client Component del spike: verifica hidratacion y coste de bundle.
export default function Contador() {
  const [n, setN] = useState(0);
  return (
    <button data-prueba="cliente-contador" onClick={() => setN(n + 1)}>
      hidratado: {n}
    </button>
  );
}
