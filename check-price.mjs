import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DIAMOND_CODE = process.env.DIAMOND_CODE || "LG789634401";

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601" +
  "?carat_weight=2.04" +
  "&diamond_code=LG789634401" +
  "&metal_purity=PL_950_W" +
  "&ring_size=R15_7" +
  "&stone_carat=200" +
  "&stone_certificate=IGI" +
  "&stone_clarity=VVS2" +
  "&stone_color=E" +
  "&stone_fluorescence=FNO" +
  "&stone_polish=EX" +
  "&stone_shape=OVL" +
  "&stone_symmetry=EX" +
  "&stone_type=LAB" +
  "&store_id=6";

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

try {
  const buttons = [
    page.getByText("Accept All Cookies", { exact: true }),
    page.locator("#onetrust-accept-btn-handler")
  ];

  for (const button of buttons) {
    if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("Cookie banner found. Accepting cookies...");
      await button.click();
      await page.waitForTimeout(1000);
      break;
    }
  }
} catch {
  console.log("No cookie banner requiring interaction.");
}

// Wait for the hidden stone section to be present
await page.waitForSelector("#stone_price_grid", {
  state: "attached",
  timeout: 60000
});

console.log("Specific-stone section exists.");

const gridInfo = await page.evaluate(() => {
  const grid = document.querySelector("#stone_price_grid");

  return {
    exists: !!grid,
    htmlLength: grid?.innerHTML.length || 0,
    hasDiamondSearch: !!document.querySelector("#diamondSearch"),
    diamondCode: document.querySelector("#diamond_code")?.value || null,
    caratWeight: document.querySelector("#carat_weight")?.value || null
  };
});

console.log("Stone grid info:", gridInfo);
  
// Reveal it
await page.evaluate(() => {
  const grid = document.querySelector("#stone_price_grid");

  if (grid) {
    grid.style.setProperty("display", "block", "important");
    grid.style.setProperty("visibility", "visible", "important");
    grid.style.setProperty("opacity", "1", "important");
  }
});

// Give the page a moment to render the revealed section
await page.waitForTimeout(1000);

// Now wait for the input to EXIST, not necessarily be visible yet
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
