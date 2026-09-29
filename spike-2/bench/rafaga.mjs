// Spike 2 — rafaga controlada (E5). Uso: node bench/rafaga.mjs <url> [total] [concurrencia]
const url = process.argv[2];
const total = Number(process.argv[3] ?? 500);
const conc = Number(process.argv[4] ?? 20);
if (!url) { console.error("falta url"); process.exit(1); }

let hechas = 0, ok = 0, fallos = 0;
const ms = [], estados = {};
const inicio = Date.now();

async function trabajador() {
  while (hechas < total) {
    hechas++;
    const t0 = performance.now();
    try {
      const r = await fetch(url, { cache: "no-store" });
      await r.arrayBuffer();
      ms.push(performance.now() - t0);
      estados[r.status] = (estados[r.status] ?? 0) + 1;
      if (r.ok) ok++; else fallos++;
    } catch (e) { fallos++; estados["ERR"] = (estados["ERR"] ?? 0) + 1; }
  }
}
await Promise.all(Array.from({ length: conc }, trabajador));

const s = ms.sort((a, b) => a - b);
const p = (q) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : null);
console.log(JSON.stringify({
  url, total, concurrencia: conc, duracionMs: Date.now() - inicio,
  ok, fallos, tasaErrorPct: +((fallos / total) * 100).toFixed(2),
  estados, latencia: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(s.at(-1) ?? 0) },
  ventana: { inicio: new Date(inicio).toISOString(), fin: new Date().toISOString() },
}, null, 2));
