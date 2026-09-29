import { expect, test, type Page } from "@playwright/test";

/**
 * Recorridos del MVP navegable (búsqueda, radar, plataformas, listas, Mis
 * plataformas y menú móvil), en móvil (375) y escritorio (1.440). Comprueban
 * rutas, roles y estado; nunca píxeles.
 */

async function sinScrollHorizontal(page: Page) {
  const desborde = await page.evaluate(() => {
    const raiz = document.scrollingElement ?? document.documentElement;
    return raiz.scrollWidth - raiz.clientWidth;
  });
  expect(desborde).toBeLessThanOrEqual(0);
}

/** Los botones de las islas responden al hidratar; en desarrollo tarda. */
async function pulsarCuandoHidrate(
  page: Page,
  pulsar: () => Promise<void>,
  hecho: () => Promise<void>,
) {
  await expect(async () => {
    await pulsar();
    await hecho();
  }).toPass();
}

/** Va a un destino primario: barra en escritorio, menú en móvil. */
async function irA(page: Page, isMobile: boolean, destino: string) {
  if (isMobile) {
    const dialogo = page.getByRole("dialog", { name: "Menú" });
    await pulsarCuandoHidrate(
      page,
      () => page.getByRole("button", { name: "Menú" }).click(),
      () => expect(dialogo).toBeVisible({ timeout: 1000 }),
    );
    await dialogo.getByRole("link", { name: destino }).click();
  } else {
    await page
      .getByRole("navigation", { name: "Principal" })
      .getByRole("link", { name: destino })
      .click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ml.e2e")) {
      localStorage.clear();
      sessionStorage.setItem("ml.e2e", "1");
    }
  });
});

test("1 · portada → buscar → resultados → película → volver", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Buscar" }).click();
  await expect(page).toHaveURL(/\/buscar$/);
  const campo = page.getByRole("searchbox", { name: "Busca una película o serie" });
  await expect(campo).toBeFocused();
  await campo.fill("faro");
  await campo.press("Enter");

  await expect(page).toHaveURL(/\/buscar\?q=faro$/);
  await expect(page.getByText(/resultados? para «faro»/)).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: /^Películas/ }),
  ).toBeVisible();
  await sinScrollHorizontal(page);

  await page.getByRole("link", { name: "La casa del faro" }).click();
  await expect(page).toHaveURL(/\/peliculas\/la-casa-del-faro$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("La casa del faro");

  await page.goBack();
  await expect(page).toHaveURL(/\/buscar\?q=faro$/);
  await expect(
    page.getByRole("searchbox", { name: "Busca una película o serie" }),
  ).toHaveValue("faro");
});

test("búsqueda sin resultados: mensaje honesto, sin error técnico", async ({
  page,
}) => {
  await page.goto("/buscar?q=zzzz");
  await expect(
    page.getByRole("heading", { name: "No tenemos «zzzz» en el catálogo" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Listas firmadas" }).first(),
  ).toBeVisible();
  await sinScrollHorizontal(page);
});

test("2 · portada → radar → filtrar plataforma → filtrar tipo → título", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await irA(page, isMobile, "Radar");
  await expect(page).toHaveURL(/\/radar$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Radar del catálogo",
  );

  const plataforma = page.getByRole("group", { name: "Plataforma" });
  if (isMobile) {
    // En móvil la plataforma empieza plegada (divulgación progresiva).
    await pulsarCuandoHidrate(
      page,
      () => plataforma.getByRole("button", { name: /cambiar plataforma/ }).click(),
      () =>
        expect(
          plataforma.getByRole("button", { name: /^Netflix\s*,\s*\d+$/ }),
        ).toBeVisible({ timeout: 1000 }),
    );
  }
  await pulsarCuandoHidrate(
    page,
    () => plataforma.getByRole("button", { name: /^Netflix\s*,\s*\d+$/ }).click(),
    () => expect(page).toHaveURL(/plataforma=netflix/, { timeout: 1000 }),
  );
  await expect(
    plataforma.getByRole("button", { name: /^Netflix\s*,\s*\d+$/ }),
  ).toHaveAttribute("aria-pressed", "true");

  const tipo = page.getByRole("group", { name: "Tipo" });
  await tipo.getByRole("button", { name: /^Se va\s*,\s*\d+$/ }).click();
  await expect(page).toHaveURL(/tipo=se-va/);
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /movimientos?, filtrados por Se va y Netflix/ }),
  ).toHaveCount(1);
  // Solo salidas de Netflix: lo demás no se pinta.
  await expect(page.getByRole("link", { name: "Cinco noches" })).toHaveCount(0);
  await sinScrollHorizontal(page);

  await page.getByRole("link", { name: "Palabras cruzadas" }).first().click();
  await expect(page).toHaveURL(/\/series\/palabras-cruzadas$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Palabras cruzadas");

  // Volver conserva los filtros: están en la URL.
  await page.goBack();
  await expect(page).toHaveURL(/tipo=se-va/);
  await expect(
    page
      .getByRole("group", { name: "Tipo" })
      .getByRole("button", { name: /^Se va\s*,\s*\d+$/ }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("radar: una plataforma sin la capacidad lo explica, no enseña un vacío mudo", async ({
  page,
}) => {
  await page.goto("/radar?plataforma=skyshowtime&tipo=proximamente");
  await expect(
    page.getByText("SkyShowtime no anuncia sus próximas llegadas.").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Quitar filtros" }).first(),
  ).toBeVisible();
});

test("3 · plataformas → Netflix → título → disponibilidad", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  await irA(page, isMobile, "Plataformas");
  await expect(page).toHaveURL(/\/plataformas$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Qué ver en cada plataforma",
  );
  await sinScrollHorizontal(page);

  await page
    .getByRole("link", { name: /^Netflix/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/plataformas\/netflix$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Qué ver en Netflix",
  );
  await expect(page.getByRole("navigation", { name: "En esta página" })).toBeVisible();
  await sinScrollHorizontal(page);

  const loMejor = page.getByRole("region", { name: /Lo mejor de Netflix/ });
  await loMejor.getByRole("link", { name: "Cinco noches" }).click();
  await expect(page).toHaveURL(/\/series\/cinco-noches$/);
  const panel = page.getByRole("region", { name: "Dónde ver Cinco noches" });
  await expect(panel.locator('li[data-plataforma="netflix"]')).toBeVisible();
  await expect(panel.getByText(/^Comprobado/)).toBeVisible();
});

test("4 · listas → lista → título", async ({ page, isMobile }) => {
  await page.goto("/");
  await irA(page, isMobile, "Listas");
  await expect(page).toHaveURL(/\/listas$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Listas");
  await sinScrollHorizontal(page);

  await page
    .getByRole("link", { name: "Catorce títulos para las noches de otoño" })
    .click();
  await expect(page).toHaveURL(/\/listas\/catorce-titulos-para-las-noches-de-otono$/);
  const entradas = page.getByRole("list", { name: /^Títulos de «Catorce títulos/ });
  await expect(entradas.getByRole("heading", { level: 2 })).toHaveCount(14);
  // Lo que se fue sigue en su sitio, con fecha.
  await expect(
    entradas.getByText(/Ya no está en ninguna plataforma que seguimos/),
  ).toBeVisible();
  await sinScrollHorizontal(page);

  await entradas.getByRole("link", { name: "Estación Polar" }).click();
  await expect(page).toHaveURL(/\/series\/estacion-polar$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Estación Polar");
});

test("5 · Mis plataformas: se marca una vez y sirve en las pantallas nuevas", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  const dialogo = page.getByRole("dialog", { name: "Mis plataformas" });
  await pulsarCuandoHidrate(
    page,
    () =>
      page
        .getByRole("banner")
        .getByRole("button", { name: /^Mis plataformas/ })
        .click(),
    () => expect(dialogo).toBeVisible({ timeout: 1000 }),
  );
  await dialogo.getByRole("checkbox", { name: "Netflix" }).check();
  await dialogo.getByRole("button", { name: "Listo" }).click();

  // Una pantalla nueva: la lista. El conmutador aparece y filtra solo si se pide.
  await irA(page, isMobile, "Listas");
  await page
    .getByRole("link", { name: "Catorce títulos para las noches de otoño" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-mis-plataformas", "netflix");
  const entradas = page.getByRole("list", { name: /^Títulos de «Catorce títulos/ });
  await expect(entradas.getByRole("heading", { level: 2 })).toHaveCount(14);
  const conmutador = page.getByRole("checkbox", { name: /Solo en mis plataformas/ });
  await expect(conmutador).toBeVisible();
  await pulsarCuandoHidrate(
    page,
    () => conmutador.check(),
    () =>
      expect(entradas.getByRole("heading", { level: 2 })).toHaveCount(4, {
        timeout: 1000,
      }),
  );

  // Otra: el radar ofrece el atajo «Mis plataformas».
  await irA(page, isMobile, "Radar");
  await expect(page).toHaveURL(/\/radar$/);
  await expect(page.locator("html")).toHaveAttribute("data-mis-plataformas", "netflix");

  // Y el hub de Netflix sabe que es tuya antes de hidratar (CSS del atributo).
  await page.goto("/plataformas/netflix");
  await expect(page.getByRole("button", { name: /^En tus plataformas/ })).toBeVisible();
  await page.goto("/plataformas/hbo-max");
  await expect(
    page.getByRole("button", { name: /^Añadir a Mis plataformas/ }),
  ).toBeVisible();
});

test("6 · móvil: menú → navegación entre secciones", async ({ page, isMobile }) => {
  test.skip(!isMobile, "El menú solo existe por debajo de 1.024 px");
  await page.goto("/");
  for (const [destino, h1] of [
    ["Listas", "Listas"],
    ["Películas", "Películas"],
    ["Series", "Series"],
    ["Radar", "Radar del catálogo"],
    ["Plataformas", "Qué ver en cada plataforma"],
  ] as const) {
    await irA(page, true, destino);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
    await expect(page.getByRole("dialog", { name: "Menú" })).toBeHidden();
    await sinScrollHorizontal(page);
  }
});

test("hubs de tipo: películas y series sin desbordar y con su índice local", async ({
  page,
}) => {
  for (const ruta of ["/peliculas", "/series"]) {
    await page.goto(ruta);
    await expect(
      page.getByRole("navigation", { name: "En esta página" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: /^Radar de/ })).toBeVisible();
    await sinScrollHorizontal(page);
  }
  await expect(
    page.getByRole("heading", { name: "De una sola temporada" }),
  ).toBeVisible();
});

test("slugs inválidos: 404 real con la identidad del sitio", async ({ page }) => {
  for (const ruta of [
    "/listas/no-existe",
    "/plataformas/no-existe",
    "/plataformas/hbo",
    "/plataformas/max",
    "/plataformas/apple-tv-plus",
  ]) {
    const respuesta = await page.goto(ruta);
    expect(respuesta?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Esta página no existe o se ha movido",
    );
    await expect(
      page.getByRole("searchbox", { name: "Busca una película o serie" }),
    ).toBeVisible();
  }
});
