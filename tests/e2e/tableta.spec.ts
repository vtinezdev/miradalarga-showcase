import { expect, test, type Page } from "@playwright/test";

/**
 * Tableta (768 px): el ancho donde Quality Sprint 01 midió saltos de
 * maquetación (H01, H02) y el foco perdido del menú móvil (M02) que los
 * proyectos de 375 y 1.440 px no ejercitan. Se ejecuta solo en el proyecto
 * `tableta`.
 */

async function medirCls(page: Page, ruta: string): Promise<number> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries()) {
        const salto = e as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!salto.hadRecentInput) w.__cls += salto.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(ruta);
  // Hidratado y con las fuentes cargadas: es cuando saltaba.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return page.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

// Objetivo del proyecto (docs/SEO.md): CLS < 0,05. El servidor de desarrollo es
// más ruidoso que el build, así que aquí solo se vigila la regresión gruesa
// (H01 medía 0,56 y H02 0,14–0,20).
const CLS_MAXIMO = 0.05;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("ml.e2e")) {
      localStorage.clear();
      sessionStorage.setItem("ml.e2e", "1");
    }
  });
});

test("H01 · portada: el lema y la fecha van apilados y no saltan al cargar", async ({
  page,
}) => {
  const cls = await medirCls(page, "/");
  const lema = await page.getByRole("heading", { level: 1 }).boundingBox();
  const fecha = await page
    .locator("main p", { hasText: "Catálogo comprobado" })
    .boundingBox();
  // Apilados por construcción: no dependen de que el texto quepa o no.
  expect(fecha!.y).toBeGreaterThanOrEqual(lema!.y + lema!.height - 1);
  expect(cls).toBeLessThan(CLS_MAXIMO);
});

test("H02 · hub de plataforma: el sello no cambia de tamaño al hidratar", async ({
  page,
}) => {
  const cls = await medirCls(page, "/plataformas/skyshowtime");
  await expect(page.getByText("Comprobado", { exact: false }).first()).toBeVisible();
  expect(cls).toBeLessThan(CLS_MAXIMO);
});

test("M02 · Menú → Mis plataformas → cerrar: el foco vuelve al botón Menú", async ({
  page,
}) => {
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Menú" });
  const navegacion = page.getByRole("dialog", { name: "Menú" });
  // El botón solo responde tras hidratar; en desarrollo tarda.
  await expect(async () => {
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(navegacion).toBeVisible({ timeout: 1000 });
  }).toPass();
  await navegacion.getByRole("button", { name: "Mis plataformas" }).click();

  const hoja = page.getByRole("dialog", { name: "Mis plataformas" });
  await expect(hoja).toBeVisible();

  // Con Esc…
  await page.keyboard.press("Escape");
  await expect(hoja).toBeHidden();
  await expect(menu).toBeFocused();

  // …y con el botón «Listo», que además debe dejar el foco visible y tabulable.
  await page.keyboard.press("Enter");
  await navegacion.getByRole("button", { name: "Mis plataformas" }).click();
  await hoja.getByRole("button", { name: "Listo" }).click();
  await expect(hoja).toBeHidden();
  await expect(menu).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu).not.toBeFocused();
});
