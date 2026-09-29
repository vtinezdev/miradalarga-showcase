// Spike 2 — huella funcional de cada ruta, para comparar Next.js vs vinext vs workerd.
const base = process.argv[2] ?? "http://localhost:3000";
const RUTAS = ["/", "/isr", "/dinamica", "/titulo/uno", "/titulo/cuatro", "/db", "/cache", "/cliente", "/api/ping"];

const buscar = (html, re) => (html.match(re)?.[1] ?? null);

const salida = {};
for (const ruta of RUTAS) {
  try {
    const r = await fetch(base + ruta, { cache: "no-store" });
    const cuerpo = await r.text();
    if (ruta.startsWith("/api/")) { salida[ruta] = { status: r.status, json: JSON.parse(cuerpo) }; continue; }
    const marcas = {};
    for (const m of cuerpo.matchAll(/data-prueba="([^"]+)"[^>]*>([^<]*)</g)) marcas[m[1]] = m[2];
    salida[ruta] = {
      status: r.status,
      title: buscar(cuerpo, /<title>([^<]*)<\/title>/),
      description: buscar(cuerpo, /<meta name="description" content="([^"]*)"/),
      canonical: buscar(cuerpo, /<link rel="canonical" href="([^"]*)"/),
      og: buscar(cuerpo, /<meta property="og:title" content="([^"]*)"/),
      marcas,
      hidratacion: /data-prueba="cliente-contador"/.test(cuerpo) || null,
      bytes: cuerpo.length,
    };
  } catch (e) { salida[ruta] = { error: String(e.message ?? e) }; }
}
console.log(JSON.stringify({ base, cuando: new Date().toISOString(), rutas: salida }, null, 2));
