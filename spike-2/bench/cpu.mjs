// Spike 2 — E4: CPU por invocacion, a partir de los eventos de `wrangler tail`.
// Lee el volcado pretty-JSON de tail y agrega por pathname.
import { readFileSync } from "node:fs";

const ruta = process.argv[2];
const s = readFileSync(ruta, "utf8");

// tail escribe objetos JSON concatenados e indentados: se extraen por balanceo de llaves.
const objs = [];
let d = 0, ini = -1, enStr = false, esc = false;
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  if (esc) { esc = false; continue; }
  if (c === "\\") { esc = true; continue; }
  if (c === '"') { enStr = !enStr; continue; }
  if (enStr) continue;
  if (c === "{") { if (d === 0) ini = i; d++; }
  else if (c === "}") { d--; if (d === 0 && ini >= 0) { objs.push(s.slice(ini, i + 1)); ini = -1; } }
}

const porRuta = new Map();
const outcomes = {};
let total = 0;
for (const o of objs) {
  let j; try { j = JSON.parse(o); } catch { continue; }
  if (typeof j.cpuTime !== "number" || !j.event?.request?.url) continue;
  total++;
  outcomes[j.outcome] = (outcomes[j.outcome] ?? 0) + 1;
  const p = new URL(j.event.request.url).pathname;
  if (!porRuta.has(p)) porRuta.set(p, { cpu: [], wall: [], outcomes: {}, status: {} });
  const e = porRuta.get(p);
  e.cpu.push(j.cpuTime);
  e.wall.push(j.wallTime);
  e.outcomes[j.outcome] = (e.outcomes[j.outcome] ?? 0) + 1;
  const st = j.event?.response?.status; if (st) e.status[st] = (e.status[st] ?? 0) + 1;
}

// Solo se publican los cuantiles que la muestra sostiene.
const q = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

const filas = [...porRuta.entries()].map(([ruta, e]) => ({
  ruta, n: e.cpu.length,
  cpu_p50: q(e.cpu, 0.5),
  cpu_p99: e.cpu.length >= 100 ? q(e.cpu, 0.99) : null,
  cpu_max: Math.max(...e.cpu),
  wall_p50: q(e.wall, 0.5),
  outcomes: e.outcomes, status: e.status,
})).sort((a, b) => b.cpu_max - a.cpu_max);

console.log(JSON.stringify({
  invocaciones: total,
  outcomes,
  exceededCpu: outcomes.exceededCpu ?? 0,
  limiteFreeMs: 10,
  nota: "cpu_p99 solo se calcula con n>=100; con menos muestras no se publica.",
  filas,
}, null, 2));
