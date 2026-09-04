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

  /*
   * Make the specific-diamond request FROM INSIDE the
   * Diamonds Factory browser session.
   *
   * This means the request automatically has the cookies/session
   * created when the page loaded.
   */
  const responseText = await page.evaluate(async (diamondCode) => {
    const body = new URLSearchParams({
      stone_shape: "OVL",
      stone_carat_min: "0.80",
      stone_carat_max: "30.00",
      stone_clarity: "",
      stone_intensity: "",
      stone_color: "",
      stone_certificate: "",
      stone_cut: "",
      stone_polish: "",
      stone_symmetry: "",
      stone_fluorescence: "",
      stone_price_min: "100",
      stone_price_max: "5000000",
      show_image: "",
      show_video: "",
      show_instock: "",
      show_heart_arrows: "",
      markup: "",
      tax_class_id: "10",
      design_id: "49",
      image_stone: "di",
      side_stone: "",
      metal_purity: "PL_950_W",
      product_id: "15102",
      ring_size: "R15_7",
      active_diamond_tab: "LAB",
      diamond_code: "",
      edit_product: "",
      order: "",
      search: diamondCode,
      carat_skip: "",
      colored_stone_type: "",
      page: "1"
    });

    const response = await fetch(
      "/index.php?route=product/product/lazyloadDiamond",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body.toString()
      }
    );

    const text = await response.text();

    return text;
  }, DIAMOND_CODE);

  console.log("Diamond search response received");
  console.log("Response length:", responseText.length);

  /*
   * Diamonds Factory may return either HTML directly
   * or JSON containing HTML.
   */
  let searchableText = responseText;

  try {
    const parsed = JSON.parse(responseText);

    searchableText =
      typeof parsed === "string"
        ? parsed
        : JSON.stringify(parsed);
  } catch {
    // Not JSON, so use the raw HTML/text.
  }

  if (!searchableText.includes(DIAMOND_CODE)) {
    console.log("Diamond code not found in response.");

    fs.writeFileSync(
      "debug-response.txt",
      responseText
    );

    throw new Error(
      `Diamond ${DIAMOND_CODE} was not found. Raw response saved to debug-response.txt`
    );
  }

  /*
   * Find the HTML tag containing the diamond.
   */
  const escapedCode = DIAMOND_CODE.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const rowRegex = new RegExp(
    `<tr[^>]*(?:diamondcode=["']${escapedCode}["'][^>]*|[^>]*diamondcode=["']${escapedCode}["'])[^>]*>`,
    "i"
  );

  const rowMatch = searchableText.match(rowRegex);

  if (!rowMatch) {
    fs.writeFileSync(
      "debug-response.txt",
      responseText
    );

    throw new Error(
      `Found ${DIAMOND_CODE}, but could not locate its diamond row.`
    );
  }

  const row = rowMatch[0];

  function attr(name) {
    const match = row.match(
      new RegExp(`${name}=["']([^"']*)["']`, "i")
    );

    return match ? match[1] : null;
  }

  const diamond = {
    diamond_code: attr("diamondcode"),
    price: attr("price"),
    carat: attr("caratweight"),
    color: attr("col"),
    clarity: attr("clar"),
    certificate: attr("lab"),
    cut: attr("cut"),
    polish: attr("pol"),
    symmetry: attr("symm"),
    fluorescence: attr("fluor"),
    measurements: attr("meas")
  };

  console.log("Diamond found:");
  console.log(diamond);

  if (!diamond.price) {
    fs.writeFileSync(
      "debug-response.txt",
      responseText
    );

    throw new Error(
      "Diamond was found, but no price attribute was returned."
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

  console.log("Saved price.json");

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

  process.exitCode = 1;

} finally {
  await browser.close();
}
