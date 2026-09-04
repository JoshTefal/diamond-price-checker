import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DIAMOND_CODE = process.env.DIAMOND_CODE || "LG789634401";

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601" +
  "?diamond_code=" + encodeURIComponent(DIAMOND_CODE) +
  "&metal_purity=PL_950_W" +
  "&ring_size=R15_7" +
  "&stone_type=LAB" +
  "&store_id=6";

const PROFILE_DIR = path.resolve("./chrome-profile");

let pricingData = null;
let allowPricingCapture = false;
let searchResponseSeen = false;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  locale: "en-CA",
  timezoneId: "America/Toronto"
});

const pages = context.pages();
const page = pages.length ? pages[0] : await context.newPage();

try {
  console.log(`Opening Diamonds Factory for ${DIAMOND_CODE}...`);
  console.log("Product URL:", PRODUCT_URL);

  // Capture only pricing generated AFTER we deliberately select the target diamond.
  page.on("request", request => {
    try {
      if (!allowPricingCapture) return;

      const url = request.url();
      if (!url.includes("route=product/product/add")) return;

      const postData = request.postData();
      if (!postData) return;

      const params = new URLSearchParams(postData);
      if (params.get("diamond_code") !== DIAMOND_CODE) return;

      const settingPrice = Number(params.get("mpf"));
      const diamondPrice = Number(params.get("spf"));
      const discount = Number(params.get("offer_discount"));
      const discountPercent = Number(params.get("offer_percantage_get"));

      if (!Number.isFinite(settingPrice) || !Number.isFinite(diamondPrice)) {
        return;
      }

      const subtotal = settingPrice + diamondPrice;
      const validDiscount = Number.isFinite(discount) ? discount : 0;

      pricingData = {
        setting_price: settingPrice,
        diamond_price: diamondPrice,
        subtotal,
        discount: validDiscount,
        discount_percent: Number.isFinite(discountPercent)
          ? discountPercent
          : null,
        final_price: subtotal - validDiscount
      };

      console.log("Captured TARGET ring pricing:");
      console.log(pricingData);
    } catch (error) {
      console.log("Could not parse pricing request:", error.message);
    }
  });

  // Save the specific-stone AJAX response for debugging.
  page.on("response", async response => {
    try {
      const url = response.url();

      if (!url.includes("route=product/product/lazyloadDiamond")) {
        return;
      }

      searchResponseSeen = true;
      const text = await response.text().catch(() => "");

      fs.writeFileSync("debug-response.txt", text || "<empty response>");

      console.log(
        `Captured lazyloadDiamond response (${response.status()}, ${text.length} chars)`
      );

      if (text.includes(DIAMOND_CODE)) {
        console.log(`Search response contains ${DIAMOND_CODE}.`);
      } else {
        console.log(`Search response does NOT contain ${DIAMOND_CODE}.`);
      }
    } catch (error) {
      console.log("Could not save search response:", error.message);
    }
  });

  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(5000);

  console.log("Page title:", await page.title());
  console.log("Current URL:", page.url());

  // Accept cookies if shown.
  try {
    const buttons = [
      page.getByText("Accept All Cookies", { exact: true }),
      page.locator("#onetrust-accept-btn-handler")
    ];

    for (const button of buttons) {
      const visible = await button
        .isVisible({ timeout: 2000 })
        .catch(() => false);

      if (visible) {
        console.log("Accepting cookie banner...");
        await button.click();
        await page.waitForTimeout(1000);
        break;
      }
    }
  } catch {}

  const bodyText = await page.locator("body").innerText().catch(() => "");

  if (
    bodyText.includes("Sorry, you have been blocked") ||
    bodyText.includes("You are unable to access diamondsfactory.ca")
  ) {
    throw new Error("Diamonds Factory presented a Cloudflare block page.");
  }

  await page.waitForSelector("#stone_price_grid", {
    state: "attached",
    timeout: 60000
  });

  console.log("Specific-stone section exists.");

  await page.evaluate(() => {
    const grid = document.querySelector("#stone_price_grid");
    if (grid) {
      grid.style.setProperty("display", "block", "important");
      grid.style.setProperty("visibility", "visible", "important");
      grid.style.setProperty("opacity", "1", "important");
    }
  });

  await page.waitForTimeout(1000);

  const gridInfo = await page.evaluate(() => ({
    hasDiamondSearch: !!document.querySelector("#diamondSearch"),
    diamondCodeInput: document.querySelector("#diamond_code")?.value || null,
    caratWeightInput: document.querySelector("#carat_weight")?.value || null,
    gridHtmlLength:
      document.querySelector("#stone_price_grid")?.innerHTML.length || 0
  }));

  console.log("Stone grid info:", gridInfo);

  await page.waitForSelector("#diamondSearch", {
    state: "attached",
    timeout: 30000
  });

  const searchBox = page.locator("#diamondSearch");
  await searchBox.fill("");
  await searchBox.fill(DIAMOND_CODE, { force: true });

  console.log(`Searching specifically for ${DIAMOND_CODE}...`);

  // Wait for the search request at the same time we click.
  const searchRequestPromise = page
    .waitForRequest(
      req => req.url().includes("route=product/product/lazyloadDiamond"),
      { timeout: 30000 }
    )
    .catch(() => null);

  await page.locator("#searchDiamondBtn").click({ force: true });

  const searchRequest = await searchRequestPromise;

  if (searchRequest) {
    const postData = searchRequest.postData() || "";
    fs.writeFileSync("debug-search-request.txt", postData);
    console.log("Captured diamond search request.");

    const params = new URLSearchParams(postData);
    console.log("Search request diamondSearch:", params.get("diamondSearch"));
    console.log("Search request diamond_code:", params.get("diamond_code"));
    console.log("Search request active_diamond_tab:", params.get("active_diamond_tab"));
  } else {
    console.log("Warning: no lazyloadDiamond request was observed after clicking search.");
  }

  const diamondSelector = `[diamondcode="${DIAMOND_CODE}"]`;

  // Give the search response time to update the DOM, but fail with diagnostics instead of a blind 60 s timeout.
  const found = await page
    .waitForSelector(diamondSelector, {
      state: "attached",
      timeout: 30000
    })
    .then(() => true)
    .catch(() => false);

  if (!found) {
    const searchDiagnostics = await page.evaluate(code => {
      const grid = document.querySelector("#stone_price_grid");
      const rows = Array.from(document.querySelectorAll("[diamondcode]"));

      return {
        searchedCode: code,
        rowCount: rows.length,
        returnedCodes: rows
          .slice(0, 25)
          .map(el => el.getAttribute("diamondcode")),
        gridText: (grid?.innerText || "").slice(0, 5000)
      };
    }, DIAMOND_CODE);

    fs.writeFileSync(
      "debug-dom.json",
      JSON.stringify(searchDiagnostics, null, 2)
    );

    throw new Error(
      `${DIAMOND_CODE} was not inserted into the stone grid after an exact-code search. ` +
        `lazyloadDiamond response seen: ${searchResponseSeen}. See debug-response.txt, ` +
        `debug-search-request.txt, and debug-dom.json.`
    );
  }

  const diamondRow = page.locator(diamondSelector).first();

  const diamond = await diamondRow.evaluate(el => ({
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

  console.log("Diamond found:");
  console.log(diamond);

  if (!diamond.price) {
    throw new Error("Diamond found, but loose-diamond price was missing.");
  }

  if (!diamond.stone_id) {
    throw new Error("Diamond found, but stone ID was missing.");
  }

  // Discard any page-load pricing and begin capturing only now.
  pricingData = null;
  allowPricingCapture = true;

  console.log("Selecting exact target diamond...");

  await page.evaluate(
    ({ stoneId, diamondCode, carat }) => {
      if (typeof window.stonePriceCall !== "function") {
        throw new Error("stonePriceCall is not available");
      }

      window.stonePriceCall(stoneId, diamondCode, Number(carat));
    },
    {
      stoneId: diamond.stone_id,
      diamondCode: DIAMOND_CODE,
      carat: diamond.carat
    }
  );

  for (let i = 0; i < 15 && !pricingData; i++) {
    await page.waitForTimeout(1000);
  }

  if (!pricingData) {
    console.log("Warning: target diamond found, but full ring pricing was not captured.");
  }

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    source: "Diamonds Factory Canada",
    currency: "CAD",
    product: {
      code: "CLRN07576_01",
      name: "Hidden Halo Diamond Engagement Ring"
    },
    configuration: {
      metal: "Platinum",
      metal_code: "PL_950_W",
      ring_size: "R15_7",
      stone_type: "Lab-grown"
    },
    diamond,
    pricing: pricingData
  };

  fs.writeFileSync("price.json", JSON.stringify(result, null, 2));

  console.log("Saved price.json:");
  console.log(JSON.stringify(result, null, 2));

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

  fs.writeFileSync("price.json", JSON.stringify(result, null, 2));

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
