import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DIAMOND_CODE =
  process.env.DIAMOND_CODE || "LG789634401";

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

const PROFILE_DIR = path.resolve("./chrome-profile");

let pricingData = null;

const context = await chromium.launchPersistentContext(
  PROFILE_DIR,
  {
    channel: "chrome",
    headless: false,
    viewport: {
      width: 1440,
      height: 1000
    },
    locale: "en-CA",
    timezoneId: "America/Toronto"
  }
);

const pages = context.pages();
const page = pages.length ? pages[0] : await context.newPage();

try {
  console.log("Opening Diamonds Factory...");

  page.on("request", request => {
    try {
      const url = request.url();

      if (!url.includes("route=product/product/add")) {
        return;
      }

      const postData = request.postData();

      if (!postData) {
        return;
      }

      const params = new URLSearchParams(postData);

      if (params.get("diamond_code") !== DIAMOND_CODE) {
        return;
      }

      const settingPrice = Number(params.get("mpf"));
      const diamondPrice = Number(params.get("spf"));
      const discount = Number(params.get("offer_discount"));
      const discountPercent = Number(
        params.get("offer_percantage_get")
      );

      if (
        !Number.isFinite(settingPrice) ||
        !Number.isFinite(diamondPrice)
      ) {
        return;
      }

      const subtotal = settingPrice + diamondPrice;
      const validDiscount =
        Number.isFinite(discount) ? discount : 0;

      pricingData = {
        setting_price: settingPrice,
        diamond_price: diamondPrice,
        subtotal,
        discount: validDiscount,
        discount_percent:
          Number.isFinite(discountPercent)
            ? discountPercent
            : null,
        final_price: subtotal - validDiscount
      };

      console.log("Captured ring pricing:");
      console.log(pricingData);

    } catch (error) {
      console.log(
        "Could not parse pricing request:",
        error.message
      );
    }
  });

  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(5000);

  console.log("Page title:", await page.title());

  // Accept cookies if shown
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

  // Detect block page
  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  if (
    bodyText.includes("Sorry, you have been blocked") ||
    bodyText.includes(
      "You are unable to access diamondsfactory.ca"
    )
  ) {
    throw new Error(
      "Diamonds Factory presented a Cloudflare block page."
    );
  }

  // Reveal specific-stone section
  await page.waitForSelector("#stone_price_grid", {
    state: "attached",
    timeout: 60000
  });

  await page.evaluate(() => {
    const grid =
      document.querySelector("#stone_price_grid");

    if (grid) {
      grid.style.setProperty(
        "display",
        "block",
        "important"
      );
      grid.style.setProperty(
        "visibility",
        "visible",
        "important"
      );
      grid.style.setProperty(
        "opacity",
        "1",
        "important"
      );
    }
  });

  await page.waitForTimeout(1000);

  // Find diamond search input
  await page.waitForSelector("#diamondSearch", {
    state: "attached",
    timeout: 30000
  });

  const searchBox = page.locator("#diamondSearch");

  await searchBox.fill(DIAMOND_CODE, {
    force: true
  });

  await page
    .locator("#searchDiamondBtn")
    .click({
      force: true
    });

  console.log(
    `Searching for ${DIAMOND_CODE}`
  );

  const diamondSelector =
    `[diamondcode="${DIAMOND_CODE}"]`;

  await page.waitForSelector(diamondSelector, {
    state: "attached",
    timeout: 60000
  });

  const diamondRow =
    page.locator(diamondSelector).first();

  const diamond = await diamondRow.evaluate(
    el => ({
      diamond_code:
        el.getAttribute("diamondcode"),
      price:
        el.getAttribute("price"),
      carat:
        el.getAttribute("caratweight"),
      color:
        el.getAttribute("col"),
      clarity:
        el.getAttribute("clar"),
      certificate:
        el.getAttribute("lab"),
      certificate_number:
        el.getAttribute("cert"),
      cut:
        el.getAttribute("cut"),
      polish:
        el.getAttribute("pol"),
      symmetry:
        el.getAttribute("symm"),
      fluorescence:
        el.getAttribute("fluor"),
      measurements:
        el.getAttribute("meas"),
      stone_id:
        el.getAttribute("stoneid")
    })
  );

  console.log("Diamond found:");
  console.log(diamond);

  if (!diamond.price) {
    throw new Error(
      "Diamond found, but loose-diamond price was missing."
    );
  }

  if (!diamond.stone_id) {
    throw new Error(
      "Diamond found, but stone ID was missing."
    );
  }

  /*
   * Trigger the site's own add/select-diamond function.
   */
  console.log("Selecting exact diamond...");

  await page.evaluate(
    ({ stoneId, diamondCode, carat }) => {
      if (
        typeof window.stonePriceCall !==
        "function"
      ) {
        throw new Error(
          "stonePriceCall is not available"
        );
      }

      window.stonePriceCall(
        stoneId,
        diamondCode,
        Number(carat)
      );
    },
    {
      stoneId: diamond.stone_id,
      diamondCode: DIAMOND_CODE,
      carat: diamond.carat
    }
  );

  // Wait up to 10 seconds for pricing request
  for (
    let i = 0;
    i < 10 && !pricingData;
    i++
  ) {
    await page.waitForTimeout(1000);
  }

  if (!pricingData) {
    console.log(
      "Warning: full ring pricing was not captured."
    );
  }

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    source: "Diamonds Factory Canada",
    currency: "CAD",

    product: {
      code: "CLRN07576_01",
      name:
        "Hidden Halo Diamond Engagement Ring"
    },

    configuration: {
      metal: "Platinum",
      metal_code: "PL_950_W",
      ring_size: "R15_7",
      stone_type: "Lab-grown",
      stone_shape: "Oval"
    },

    diamond,

    pricing: pricingData
  };

  fs.writeFileSync(
    "price.json",
    JSON.stringify(result, null, 2)
  );

  console.log(
    "Saved price.json:"
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

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
