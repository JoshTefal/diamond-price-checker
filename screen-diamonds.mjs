import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const REQUEST_FILE = "screen-request.json";
const OUTPUT_FILE = "screen-results.json";

if (!fs.existsSync(REQUEST_FILE)) {
  throw new Error(`${REQUEST_FILE} is missing.`);
}

const request = JSON.parse(fs.readFileSync(REQUEST_FILE, "utf8"));

function stringList(value, fallback) {
  const source = value ?? fallback;
  const values = Array.isArray(source) ? source : [source];
  return values
    .map(v => String(v).trim().toUpperCase())
    .filter(Boolean);
}

const criteria = {
  carat_min: Number(request.carat_min ?? 2.0),
  carat_max: Number(request.carat_max ?? 2.25),
  ratio_min: Number(request.ratio_min ?? 1.3),
  ratio_max: Number(request.ratio_max ?? 1.5),
  depth_max: Number(request.depth_max ?? 63),
  table_min: Number(request.table_min ?? 53),
  table_max: Number(request.table_max ?? 58),
  shape: String(request.shape ?? "Oval"),
  stone_type: String(request.stone_type ?? "Lab-grown"),

  // Default quality profile = original diamond LG789634401.
  colors: stringList(request.colors ?? request.color, ["E"]),
  clarities: stringList(request.clarities ?? request.clarity, ["VVS2"]),
  certificates: stringList(request.certificates ?? request.certificate, ["IGI"]),
  polish: stringList(request.polish, ["EX"]),
  symmetry: stringList(request.symmetry, ["EX"]),
  fluorescence: stringList(request.fluorescence, ["FNO"])
};

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601" +
  "?metal_purity=PL_950_W" +
  "&ring_size=R15_7" +
  "&stone_shape=OVL" +
  "&stone_type=LAB" +
  "&store_id=6";

const PROFILE_DIR =
  process.platform === "win32"
    ? "C:\\diamond-price-checker-profile"
    : path.resolve("./chrome-profile");

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function priceNumber(value) {
  return parseNumber(value) ?? Number.POSITIVE_INFINITY;
}

function normalizeText(value) {
  return value === null || value === undefined
    ? ""
    : String(value).trim().toUpperCase();
}

function matchesAllowed(value, allowed) {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(normalizeText(value));
}

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
  console.log("Opening Diamonds Factory oval lab-grown inventory...");
  console.log("Criteria:", criteria);

  await page.goto(PRODUCT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  await page.waitForTimeout(3500);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (
    bodyText.includes("Sorry, you have been blocked") ||
    bodyText.includes("You are unable to access diamondsfactory.ca")
  ) {
    throw new Error("Diamonds Factory presented a Cloudflare block page.");
  }

  try {
    const cookieButton = page.locator("#onetrust-accept-btn-handler");
    if (await cookieButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cookieButton.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  await page.waitForSelector("#stone_price_grid", {
    state: "attached",
    timeout: 60000
  });

  await page.evaluate(() => {
    const grid = document.querySelector("#stone_price_grid");
    if (grid) {
      grid.style.setProperty("display", "block", "important");
      grid.style.setProperty("visibility", "visible", "important");
      grid.style.setProperty("opacity", "1", "important");
    }
  });

  await page.waitForTimeout(1000);

  let previousCount = -1;
  let stablePasses = 0;

  for (let pass = 0; pass < 24; pass++) {
    const count = await page.locator("[diamondcode]").count();
    console.log(`Inventory pass ${pass + 1}: ${count} rows in DOM`);

    if (count === previousCount) stablePasses += 1;
    else stablePasses = 0;

    previousCount = count;

    const more = page
      .getByText(/^(load more|show more|view more|more diamonds)$/i)
      .first();

    if (await more.isVisible({ timeout: 300 }).catch(() => false)) {
      await more.click({ force: true }).catch(() => {});
      await page.waitForTimeout(900);
    }

    await page.evaluate(() => {
      const grid = document.querySelector("#stone_price_grid");
      if (grid) grid.scrollTop = grid.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });

    await page.waitForTimeout(800);

    if (stablePasses >= 3 && count > 0) break;
  }

  const rows = await page.locator("[diamondcode]").evaluateAll(elements => {
    function attrs(el) {
      return Object.fromEntries(
        Array.from(el.attributes).map(a => [a.name.toLowerCase(), a.value])
      );
    }

    function firstAttr(a, names) {
      for (const name of names) {
        const value = a[name.toLowerCase()];
        if (value !== undefined && value !== "") return value;
      }
      return null;
    }

    function textValue(text, labels) {
      for (const label of labels) {
        const regex = new RegExp(
          `${label}\\s*[:\\-]?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%?`,
          "i"
        );
        const match = text.match(regex);
        if (match) return match[1];
      }
      return null;
    }

    return elements.map(el => {
      const a = attrs(el);
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();

      const ratio =
        firstAttr(a, [
          "ratio",
          "lwratio",
          "lwr",
          "lengthwidthratio",
          "length_width_ratio",
          "length-to-width-ratio"
        ]) || textValue(text, ["ratio", "l/w", "length\\s*\/\\s*width"]);

      const depth =
        firstAttr(a, [
          "depth",
          "depthpercent",
          "depthpercentage",
          "depth_percentage",
          "depth_pct"
        ]) || textValue(text, ["depth"]);

      const table =
        firstAttr(a, [
          "table",
          "tablepercent",
          "tablepercentage",
          "table_percentage",
          "table_pct"
        ]) || textValue(text, ["table"]);

      return {
        diamond_code: firstAttr(a, ["diamondcode", "diamond_code"]),
        price: firstAttr(a, ["price", "stoneprice", "spf"]),
        carat: firstAttr(a, ["caratweight", "carat", "weight"]),
        color: firstAttr(a, ["col", "color"]),
        clarity: firstAttr(a, ["clar", "clarity"]),
        certificate: firstAttr(a, ["lab", "certificate"]),
        certificate_number: firstAttr(a, ["cert", "certificatenumber", "certificate_number"]),
        cut: firstAttr(a, ["cut"]),
        polish: firstAttr(a, ["pol", "polish"]),
        symmetry: firstAttr(a, ["symm", "symmetry"]),
        fluorescence: firstAttr(a, ["fluor", "fluorescence"]),
        measurements: firstAttr(a, ["meas", "measurements"]),
        stone_id: firstAttr(a, ["stoneid", "stone_id"]),
        ratio,
        depth,
        table,
        shape: firstAttr(a, ["shape", "shp", "stoneshape"]),
        raw_attributes: a,
        row_text: text
      };
    });
  });

  const uniqueByCode = new Map();
  for (const row of rows) {
    if (row.diamond_code && !uniqueByCode.has(row.diamond_code)) {
      uniqueByCode.set(row.diamond_code, row);
    }
  }

  const uniqueRows = [...uniqueByCode.values()];

  const normalized = uniqueRows.map(row => ({
    ...row,
    carat_number: parseNumber(row.carat),
    ratio_number: parseNumber(row.ratio),
    depth_number: parseNumber(row.depth),
    table_number: parseNumber(row.table),
    price_number: priceNumber(row.price)
  }));

  const rowsWithGeometry = normalized.filter(
    d => d.ratio_number !== null && d.depth_number !== null && d.table_number !== null
  );

  if (uniqueRows.length === 0) {
    throw new Error("No diamond rows were found in the inventory grid.");
  }

  if (rowsWithGeometry.length === 0) {
    const sampleAttributes = uniqueRows.slice(0, 5).map(r => r.raw_attributes);
    fs.writeFileSync(
      "screen-debug-attributes.json",
      JSON.stringify(sampleAttributes, null, 2)
    );
    throw new Error(
      "Diamond rows were found, but ratio/depth/table could not be identified. See screen-debug-attributes.json."
    );
  }

  const matches = normalized
    .filter(d =>
      d.carat_number !== null &&
      d.carat_number >= criteria.carat_min &&
      d.carat_number <= criteria.carat_max &&
      d.ratio_number !== null &&
      d.ratio_number >= criteria.ratio_min &&
      d.ratio_number <= criteria.ratio_max &&
      d.depth_number !== null &&
      d.depth_number < criteria.depth_max &&
      d.table_number !== null &&
      d.table_number >= criteria.table_min &&
      d.table_number <= criteria.table_max &&
      matchesAllowed(d.color, criteria.colors) &&
      matchesAllowed(d.clarity, criteria.clarities) &&
      matchesAllowed(d.certificate, criteria.certificates) &&
      matchesAllowed(d.polish, criteria.polish) &&
      matchesAllowed(d.symmetry, criteria.symmetry) &&
      matchesAllowed(d.fluorescence, criteria.fluorescence)
    )
    .sort((a, b) => a.price_number - b.price_number)
    .map(({ raw_attributes, row_text, ...d }) => d);

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    requested_at: request.requested_at || null,
    source: "Diamonds Factory Canada",
    currency: "CAD",
    criteria,
    inventory_rows_found: uniqueRows.length,
    rows_with_ratio_depth_table: rowsWithGeometry.length,
    match_count: matches.length,
    matches
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await page.screenshot({
    path: "screen-success.png",
    fullPage: true
  });
} catch (error) {
  console.error("Diamond screen failed:", error);

  const result = {
    success: false,
    checked_at: new Date().toISOString(),
    requested_at: request.requested_at || null,
    criteria,
    error: error.message
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));

  try {
    await page.screenshot({
      path: "screen-failure.png",
      fullPage: true
    });
  } catch {}

  process.exitCode = 1;
} finally {
  await context.close();
}
