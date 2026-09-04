import { chromium } from "playwright";
import fs from "fs";

const DIAMOND_CODE = process.env.DIAMOND_CODE || "LG789634401";

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601";

const browser = await chromium.launch({
  headless: true
});

const context = await browser.newContext({
  locale: "en-CA",
  timezoneId: "America/Toronto",
  viewport: {
    width: 1440,
    height: 1000
  }
});

const page = await context.newPage();

try {
  console.log("Opening Diamonds Factory...");

  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.waitForTimeout(5000);

  console.log("Page loaded");

  // The specific-stone grid exists but may initially be hidden.
  await page.evaluate(() => {
    const grid = document.querySelector("#stone_price_grid");

    if (grid) {
      grid.style.display = "block";
    }
  });

  // Wait for the diamond-code search box.
  await page.waitForSelector("#diamondSearch", {
    timeout: 30000
  });

  console.log(`Searching for ${DIAMOND_CODE}`);

  await page.fill("#diamondSearch", DIAMOND_CODE);

  await page.click("#searchDiamondBtn");

  // Wait for the exact diamond to appear in the returned inventory.
  const selector = `[diamondcode="${DIAMOND_CODE}"]`;

  await page.waitForSelector(selector, {
    timeout: 30000
  });

  const diamond = await page.locator(selector).first().evaluate((el) => ({
    diamond_code: el.getAttribute("diamondcode"),
    price: el.getAttribute("price"),
    carat: el.getAttribute("caratweight"),
    color: el.getAttribute("col"),
    clarity: el.getAttribute("clar"),
    certificate: el.getAttribute("lab"),
    cut: el.getAttribute("cut"),
    polish: el.getAttribute("pol"),
    symmetry: el.getAttribute("symm"),
    fluorescence: el.getAttribute("fluor"),
    measurements: el.getAttribute("meas")
  }));

  const checkedAt = new Date().toISOString();

  const result = {
    success: true,
    checked_at: checkedAt,
    source: "Diamonds Factory Canada",
    product: "CLRN07576_01",
    diamond
  };

  console.log(result);

  fs.writeFileSync(
    "price.json",
    JSON.stringify(result, null, 2)
  );

} catch (error) {
  console.error("Price check failed:");
  console.error(error);

  // Saving an error is useful because we can distinguish
  // "price changed" from "the checker stopped working."
  const result = {
    success: false,
    checked_at: new Date().toISOString(),
    diamond_code: DIAMOND_CODE,
    error: error.message
  };

  fs.writeFileSync(
    "price.json",
    JSON.stringify(result, null, 2)
  );

  process.exitCode = 1;

} finally {
  await browser.close();
}
