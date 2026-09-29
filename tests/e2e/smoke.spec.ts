import { expect, test, type Page } from "@playwright/test";

/**
 * Humo del vertical: portada → ficha → disponibilidad → Mis plataformas →
 * volver. Se ejecuta en móvil (375) y escritorio (1.440).
 */

async function sinScrollHorizontal(page: Page) {
  const desborde = await page.evaluate(() => {
    const raiz = document.scrollingElement ?? document.documentElement;
    return raiz.scrollWidth - raiz.clientWidth;
  });
  expect(desborde).toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
  // Cada prueba empieza sin Mis plataformas.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ml.e2e")) {
      localStorage.clear();
      sessionStorage.setItem("ml.e2e", "1");
    }
  });
});

test("portada → título → disponibilidad → Mis plataformas → volver", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Qué merece la pena ver, y dónde verlo",
  );
  await sinScrollHorizontal(page);

  // Abrir un título desde la selección principal.
  await page.getByRole("link", { name: "Cinco noches" }).first().click();
  await expect(page).toHaveURL(/\/series\/cinco-noches$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cinco noches");

  // Disponibilidad: arriba, con fecha de comprobación y orden neutro.
  const panel = page.getByRole("region", { name: "Dónde ver Cinco noches" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^Comprobado/)).toBeVisible();
  const grupos = panel.locator("li[data-plataforma]");
  await expect(grupos).toHaveCount(2);
  await expect(grupos.first()).toHaveAttribute("data-plataforma", "netflix");
  await sinScrollHorizontal(page);

  // Mis plataformas desde la cabecera: marcar HBO Max.
  await page
    .getByRole("banner")
    .getByRole("button", { name: /^Mis plataformas/ })
    .click();
  const dialogo = page.getByRole("dialog", { name: "Mis plataformas" });
  await expect(dialogo).toBeVisible();
  await dialogo.getByRole("checkbox", { name: "HBO Max" }).check();
  await expect(dialogo.getByRole("status")).toHaveText("Guardado: HBO Max.");
  await dialogo.getByRole("button", { name: "Listo" }).click();
  await expect(dialogo).toBeHidden();

  // Tus plataformas suben arriba; el resaltado va por el atributo de <html>.
  await expect(page.locator("html")).toHaveAttribute("data-mis-plataformas", "max");
  await expect(grupos.first()).toHaveAttribute("data-plataforma", "max");
  await expect(grupos.first().getByText("En tus plataformas")).toBeVisible();
  const guardado = await page.evaluate(() => localStorage.getItem("ml.plataformas"));
  expect(JSON.parse(guardado ?? "null")).toMatchObject({ v: 1, ids: ["max"] });

  // Persiste al recargar, y el atributo existe antes de que React hidrate.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mis-plataformas", "max");
  await expect(grupos.first()).toHaveAttribute("data-plataforma", "max");

  // Volver a la portada: la selección también está allí.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  const selector = page.getByRole("group", { name: "Mis plataformas" });
  await expect(selector.getByRole("checkbox", { name: "HBO Max" })).toBeChecked();
  await expect(selector.getByRole("checkbox", { name: "Netflix" })).not.toBeChecked();
});

test("ficha sin imagen: cabecera tipográfica y sin sinopsis inventada", async ({
  page,
}) => {
  await page.goto("/series/distrito-once");
  const cabecera = page.locator("article header").first();
  await expect(cabecera.locator("img")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sinopsis" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Dónde ver Distrito Once" }),
  ).toBeVisible();
  await sinScrollHorizontal(page);
});

test("título largo sin desbordar en ninguna anchura", async ({ page }) => {
  await page.goto(
    "/peliculas/todo-lo-que-no-nos-dijimos-el-invierno-en-que-dejamos-de-escribirnos-cartas",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await sinScrollHorizontal(page);
});

test("una ficha que no existe responde 404 con salida útil", async ({ page }) => {
  const respuesta = await page.goto("/peliculas/no-existe");
  expect(respuesta?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "Volver a la portada" })).toBeVisible();
});

test("teclado: el primer Tab lleva a «Saltar al contenido»", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const salto = page.getByRole("link", { name: "Saltar al contenido" });
  await expect(salto).toBeFocused();
  await expect(salto).toBeInViewport();
});

test("navegación: el menú o la barra según el ancho, y Esc cierra el menú", async ({
  page,
  isMobile,
}) => {
  await page.goto("/peliculas/la-casa-del-faro");
  if (isMobile) {
    const menu = page.getByRole("button", { name: "Menú" });
    const dialogo = page.getByRole("dialog", { name: "Menú" });
    // El botón solo responde tras hidratar (deuda anotada: menú con `popover`
    // nativo para que funcione antes); en el servidor de desarrollo tarda.
    await expect(async () => {
      await menu.click();
      await expect(dialogo).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect(dialogo.getByRole("link", { name: "Películas" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.keyboard.press("Escape");
    await expect(dialogo).toBeHidden();
    await expect(menu).toBeFocused();
  } else {
    const nav = page.getByRole("navigation", { name: "Principal" });
    await expect(nav.getByRole("link", { name: "Películas" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("button", { name: "Menú" })).toBeHidden();
  }
});

test("radar de la portada: regla temporal que parte de hoy y se recorre con botones", async ({
  page,
}) => {
  await page.goto("/");
  const radar = page.getByRole("region", { name: "Radar del catálogo" });
  const pista = radar.getByRole("list", { name: /^Movimientos del catálogo por día/ });
  const dias = pista.locator(":scope > li");
  // Pasado, hoy y futuro, en orden cronológico en el HTML.
  const fechas = await dias
    .locator("h3 time")
    .evaluateAll((l) => l.map((t) => t.getAttribute("datetime") ?? ""));
  expect(fechas).toEqual([...fechas].sort());
  const hoy = pista.locator("[data-hoy]");
  await expect(hoy).toHaveCount(1);
  await expect(hoy.getByRole("heading", { level: 3 })).toBeVisible();
  // Parte de hoy: el día de la edición está dentro de la pista sin tocar nada.
  await expect
    .poll(() =>
      hoy.evaluate((dia) => {
        const d = dia.getBoundingClientRect();
        const p = dia.parentElement!.getBoundingClientRect();
        return d.left >= p.left && d.left < p.right - d.width / 2;
      }),
    )
    .toBe(true);
  const antes = await pista.evaluate((el) => el.scrollLeft);
  await radar.getByRole("button", { name: "Después" }).click();
  await expect.poll(() => pista.evaluate((el) => el.scrollLeft)).toBeGreaterThan(antes);
  await radar.getByRole("button", { name: "Hoy" }).click();
  await expect.poll(() => pista.evaluate((el) => el.scrollLeft)).toBe(antes);
  await sinScrollHorizontal(page);
});

test("rail editorial: listas firmadas en horizontal, sin desbordar la página", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const rail = page.getByRole("list", { name: "Listas firmadas" });
  await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(4);
  if (isMobile) {
    // En móvil la siguiente pieza asoma: hay recorrido horizontal.
    const recorrido = await rail.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(recorrido).toBeGreaterThan(0);
  }
  await sinScrollHorizontal(page);
});

test("ranking invertido: la fila con foco se vuelve papel, sin depender del ratón", async ({
  page,
}) => {
  await page.goto("/");
  const lista = page.getByRole("list", { name: "Series mejor valoradas" });
  const enlace = lista.getByRole("link").first();
  await enlace.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(enlace).toBeFocused();
  const fila = lista.locator("article").first();
  await expect(fila).toHaveCSS("color", "rgb(14, 13, 11)");
});

test("movimiento reducido: nada en marcha y la cabecera fija de siempre", async ({
  browser,
}) => {
  const contexto = await browser.newContext({ reducedMotion: "reduce" });
  const page = await contexto.newPage();
  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, 1200));
  await expect
    .poll(() =>
      page.evaluate(
        () => document.getAnimations().filter((a) => a.playState === "running").length,
      ),
    )
    .toBe(0);
  await expect(page.getByRole("banner")).toHaveCSS("top", "0px");
  // El sumario del hero está entero, sin esperar a ninguna entrada.
  const entradas = page.getByRole("list", { name: /^En «/ }).getByRole("listitem");
  await expect(entradas.first()).toHaveCSS("opacity", "1");
  await contexto.close();
});
