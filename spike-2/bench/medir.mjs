// Spike 2 — medicion sin dependencias (Node >= 20).
// Uso: node bench/medir.mjs <base-url> [repeticiones] [--rafaga N C ruta]
const base = process.argv[2] ?? "http://localhost:3000";
const reps = Number(process.argv[3] ?? 1);

const RUTAS = ["/", "/estatica-forzada", "/isr", "/dinamica", "/titulo/uno", "/titulo/cuatro", "/db", "/cache", "/cliente", "/api/ping", "/logo.svg", "/pixel.png"];

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

// TTFB real: tiempo hasta el primer trozo del cuerpo.
async function medirUna(url) {
  const t0 = performance.now();
  const r = await fetch(url, { redirect: "manual", cache: "no-store" });
  const reader = r.body?.getReader();
  if (reader) { await reader.read(); await reader.cancel().catch(() => {}); }
  const ttfb = performance.now() - t0;
  return {
    ttfb,
    status: r.status,
    ray: r.headers.get("cf-ray"),
    cache: r.headers.get("cf-cache-status"),
    age: r.headers.get("age"),
    cc: r.headers.get("cache-control"),
    server: r.headers.get("server"),
  };
}

const resultados = [];
for (const ruta of RUTAS) {
  const ms = [];
  let ultima = null;
  let errores = 0;
  for (let i = 0; i < reps; i++) {
    try { ultima = await medirUna(base + ruta); ms.push(ultima.ttfb); }
    catch (e) { errores++; ultima = { status: "ERR " + (e.message ?? e) }; }
  }
  resultados.push({
    ruta, n: reps, errores,
    status: ultima?.status, p50: pct(ms, 50), p75: pct(ms, 75), p95: pct(ms, 95),
    min: ms.length ? Math.round(Math.min(...ms)) : null,
    colo: ultima?.ray ? ultima.ray.split("-").pop() : null,
    cfCache: ultima?.cache ?? null, age: ultima?.age ?? null, cacheControl: ultima?.cc ?? null,
  });
}
console.log(JSON.stringify({ base, reps, cuando: new Date().toISOString(), resultados }, null, 2));
