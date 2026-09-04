import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DIAMOND_CODE = process.env.DIAMOND_CODE || "LG789634401";

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601";

// Dedicated Chrome profile so Diamonds Factory can keep its own cookies/session
// between price checks without touching your normal Chrome profile.
const PROFILE_DIR = path.resolve("./chrome-profile");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: {
    width: 1440,
    height: 1000
  },
  locale: "en-CA",
  timezoneId: "America/Toronto"
});

const pages = context.pages();
const page = pages.length ? pages[0] : await context.newPage();

try {
  console.log("Opening Diamonds Factory in installed Google Chrome...");

  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(5000);

  console.log("Current URL:", page.url());
  console.log("Page title:", await page.title());

  // Detect an obvious Cloudflare block instead of waiting 30 sec for selectors.
  const bodyText = await page.locator("body").innerText().catch(() => "");

  if (
    bodyText.includes("Sorry, you have been blocked") ||
    bodyText.includes("You are unable to access diamondsfactory.ca")
  ) {
    await page.screenshot({
      path: "blocked-page.png",
      fullPage: true
    });

    throw new Error(
      "Diamonds Factory presented a Cloudflare block page in Chrome."
    );
  }

  /*
   * Wait for the actual stone-price area to exist in the DOM.
   * We use state: attached because Diamonds Factory intentionally hides it.
   */
  await page.waitForSelector("#stone_price_grid", {
    state: "attached",
    timeout: 60000
  });

  console.log("Specific-stone section exists.");

  /*
   * Reveal the hidden section exactly like you did manually in DevTools.
   */
  await page.evaluate(() => {
    const grid = document.querySelector("#stone_price_grid");

    if (grid) {
      grid.style.setProperty("display", "block", "important");
      grid.style.visibility = "visible";
      grid.style.opacity = "1";
    }
  });

  await page.waitForSelector("#diamondSearch", {
    state: "attached",
    timeout: 30000
  });

  console.log("Diamond search field found.");

  const searchBox = page.locator("#diamondSearch");

  await searchBox.scrollIntoViewIfNeeded();

  // Use the real input field.
  await searchBox.fill(DIAMOND_CODE, {
    force: true
  });

  console.log(`Entered diamond code ${DIAMOND_CODE}`);

  // Click the site's actual search control.
  await page.locator("#searchDiamondBtn").click({
    force: true
  });

  console.log("Clicked diamond search.");

  /*
   * Wait for Diamonds Factory itself to populate the exact diamond row.
   */
  const diamondSelector =
    `[diamondcode="${DIAMOND_CODE}"]`;

  await page.waitForSelector(diamondSelector, {
    state: "attached",
    timeout: 60000
  });

  console.log("Exact diamond returned by Diamonds Factory.");

  const diamond = await page
    .locator(diamondSelector)
    .first()
    .evaluate((el) => ({
      diamond_code: el.getAttribute("diamondcode"),
      price: el.getAttribute("price"),
      carat: el.getAttribute("caratweight"),
      color: el.getAttribute("col"),
      clarity: el.getAttribute("clar"),
      certificate: el.getAttribute("lab"),
      certificate_number: el.getAttribute("cert"),
      cut: el.getAttribute("cut"),
      polish: el.getAttribute("pol"),
      symmetry: el.getAttribute("symm"),
      fluorescence: el.getAttribute("fluor"),
      measurements: el.getAttribute("meas"),
      stone_id: el.getAttribute("stoneid")
    }));

  console.log("Diamond data retrieved:");
  console.log(diamond);

  if (!diamond.price) {
    throw new Error(
      `${DIAMOND_CODE} was found but Diamonds Factory did not return a price.`
    );
  }

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    source: "Diamonds Factory Canada",
    product: "CLRN07576_01",
    diamond
  };

  fs.writeFileSync(
    "price.json",
    JSON.stringify(result, null, 2)
  );

  console.log("Successfully saved price.json");

  await page.screenshot({
    path: "successful-check.png",
    fullPage: true
  });

} catch (error) {
  console.error("Price check failed:");
  console.error(error);

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

  try {
    await page.screenshot({
      path: "failure-screenshot.png",
      fullPage: true
    });
  } catch {}

  process.exitCode = 1;

} finally {
  await context.close();
}
