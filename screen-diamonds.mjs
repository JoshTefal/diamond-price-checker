import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const REQUEST_FILE = "screen-request.json";
const OUTPUT_FILE = "screen-results.json";

if (!fs.existsSync(REQUEST_FILE)) throw new Error(`${REQUEST_FILE} is missing.`);
const request = JSON.parse(fs.readFileSync(REQUEST_FILE, "utf8"));

function stringList(value, fallback) {
  const source = value ?? fallback;
  return (Array.isArray(source) ? source : [source])
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
  colors: stringList(request.colors ?? request.color, ["E"]),
  clarities: stringList(request.clarities ?? request.clarity, ["VVS2"]),
  certificates: stringList(request.certificates ?? request.certificate, ["IGI"]),
  polish: stringList(request.polish, ["EX"]),
  symmetry: stringList(request.symmetry, ["EX"]),
  fluorescence: stringList(request.fluorescence, ["FNO"])
};

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601" +
  "?metal_purity=PL_950_W&ring_size=R15_7&stone_type=LAB&store_id=6";

const PROFILE_DIR = process.platform === "win32"
  ? "C:\\diamond-price-checker-profile"
  : path.resolve("./chrome-profile");

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normalizeText(value) {
  return value == null ? "" : String(value).trim().toUpperCase();
}

function matchesAllowed(value, allowed) {
  return !allowed?.length || allowed.includes(normalizeText(value));
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 1000 },
  locale: "en-CA",
  timezoneId: "America/Toronto"
});

const page = context.pages()[0] || await context.newPage();
let lastLazyResponse = null;

page.on("response", async response => {
  try {
    if (!response.url().includes("route=product/product/lazyloadDiamond")) return;
    const text = await response.text().catch(() => "");
    lastLazyResponse = { status: response.status(), url: response.url(), text };
    fs.writeFileSync("screen-lazyload-response.txt", text || "<empty>");
    console.log(`lazyloadDiamond response: ${response.status()}, ${text.length} chars`);
  } catch {}
});

try {
  console.log("Opening Diamonds Factory product page...");
  console.log("Criteria:", criteria);

  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (bodyText.includes("Sorry, you have been blocked") || bodyText.includes("You are unable to access diamondsfactory.ca")) {
    throw new Error("Diamonds Factory presented a Cloudflare block page.");
  }

  try {
    const cookieButton = page.locator("#onetrust-accept-btn-handler");
    if (await cookieButton.isVisible({ timeout: 1200 }).catch(() => false)) await cookieButton.click();
  } catch {}

  // The inventory is not populated merely by loading the page. Reproduce the
  // same normal UI path a shopper uses: lab-grown -> oval -> the carat bucket
  // that contains 2.00-2.25 ct stones.
  const labButton = page.getByText(/lab created diamond/i).first();
  if (await labButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    await labButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }

  // Oval is the second shape on this product page. Prefer accessible labels,
  // then fall back to clicking the second visible shape control.
  let ovalClicked = false;
  for (const loc of [
    page.getByRole("button", { name: /oval/i }).first(),
    page.locator('[title*="Oval" i], [aria-label*="Oval" i], [data-shape="OVL" i]').first()
  ]) {
    if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
      await loc.click({ force: true }).catch(() => {});
      ovalClicked = true;
      break;
    }
  }
  if (!ovalClicked) {
    const shapeCandidates = page.locator('input[name*="shape" i], .shape-list label, [class*="shape" i] label');
    if (await shapeCandidates.count().catch(() => 0) >= 2) {
      await shapeCandidates.nth(1).click({ force: true }).catch(() => {});
    }
  }
  await page.waitForTimeout(700);

  // The screenshot from the failed run shows buckets 0.80-1.00, 1.20-4.00,
  // and 4.50-10.00. 2.00-2.25 belongs in 1.20-4.00.
  const caratBucket = page.getByText(/1\.20\s*-\s*4\.00/i).first();
  if (!(await caratBucket.isVisible({ timeout: 3000 }).catch(() => false))) {
    throw new Error('Could not find the 1.20-4.00 carat inventory control.');
  }

  const lazyRequest = page.waitForRequest(
    req => req.url().includes("route=product/product/lazyloadDiamond"),
    { timeout: 15000 }
  ).catch(() => null);

  console.log("Opening 1.20-4.00 ct inventory...");
  await caratBucket.click({ force: true });
  const requestSeen = await lazyRequest;
  if (requestSeen) {
    fs.writeFileSync("screen-lazyload-request.txt", requestSeen.postData() || "<no post data>");
    console.log("Observed lazyloadDiamond inventory request.");
  } else {
    console.log("No lazyloadDiamond request observed immediately; continuing with DOM checks.");
  }

  await page.waitForTimeout(2500);

  const grid = page.locator("#stone_price_grid");
  if (await grid.count()) {
    await page.evaluate(() => {
      const el = document.querySelector("#stone_price_grid");
      if (el) {
        el.style.setProperty("display", "block", "important");
        el.style.setProperty("visibility", "visible", "important");
        el.style.setProperty("opacity", "1", "important");
      }
    });
  }

  // Some versions use a modal/table outside #stone_price_grid. We therefore
  // search the entire DOM for diamondcode rows.
  let previousCount = -1;
  let stablePasses = 0;
  for (let pass = 0; pass < 20; pass++) {
    const count = await page.locator("[diamondcode]").count();
    console.log(`Inventory pass ${pass + 1}: ${count} diamond rows`);
    stablePasses = count === previousCount ? stablePasses + 1 : 0;
    previousCount = count;

    const more = page.getByText(/^(load more|show more|view more|more diamonds)$/i).first();
    if (await more.isVisible({ timeout: 250 }).catch(() => false)) {
      await more.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
    }

    await page.evaluate(() => {
      const g = document.querySelector("#stone_price_grid");
      if (g) g.scrollTop = g.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(600);
    if (count > 0 && stablePasses >= 3) break;
  }

  const rows = await page.locator("[diamondcode]").evaluateAll(elements => {
    const firstAttr = (a, names) => {
      for (const n of names) if (a[n.toLowerCase()] != null && a[n.toLowerCase()] !== "") return a[n.toLowerCase()];
      return null;
    };
    const textValue = (text, labels) => {
      for (const label of labels) {
        const m = text.match(new RegExp(`${label}\\s*[:\\-]?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%?`, "i"));
        if (m) return m[1];
      }
      return null;
    };

    return elements.map(el => {
      const a = Object.fromEntries(Array.from(el.attributes).map(x => [x.name.toLowerCase(), x.value]));
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
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
        ratio: firstAttr(a, ["ratio", "lwratio", "lwr", "lengthwidthratio", "length_width_ratio", "length-to-width-ratio"]) || textValue(text, ["ratio", "l/w", "length\\s*\\/\\s*width"]),
        depth: firstAttr(a, ["depth", "depthpercent", "depthpercentage", "depth_percentage", "depth_pct"]) || textValue(text, ["depth"]),
        table: firstAttr(a, ["table", "tablepercent", "tablepercentage", "table_percentage", "table_pct"]) || textValue(text, ["table"]),
        shape: firstAttr(a, ["shape", "shp", "stoneshape"]),
        raw_attributes: a,
        row_text: text
      };
    });
  });

  const unique = new Map();
  for (const row of rows) if (row.diamond_code && !unique.has(row.diamond_code)) unique.set(row.diamond_code, row);
  const uniqueRows = [...unique.values()];

  if (!uniqueRows.length) {
    fs.writeFileSync("screen-debug-page.html", await page.content());
    fs.writeFileSync("screen-debug-text.txt", (await page.locator("body").innerText().catch(() => "")).slice(0, 30000));
    throw new Error(`No diamond rows were found after opening the 1.20-4.00 ct inventory. lazyload response seen: ${!!lastLazyResponse}.`);
  }

  const normalized = uniqueRows.map(row => ({
    ...row,
    carat_number: parseNumber(row.carat),
    ratio_number: parseNumber(row.ratio),
    depth_number: parseNumber(row.depth),
    table_number: parseNumber(row.table),
    price_number: parseNumber(row.price) ?? Number.POSITIVE_INFINITY
  }));

  const rowsWithGeometry = normalized.filter(d => d.ratio_number != null && d.depth_number != null && d.table_number != null);
  if (!rowsWithGeometry.length) {
    fs.writeFileSync("screen-debug-attributes.json", JSON.stringify(uniqueRows.slice(0, 10), null, 2));
    throw new Error("Diamond rows loaded, but ratio/depth/table attribute names still need mapping. See screen-debug-attributes.json.");
  }

  const matches = normalized
    .filter(d =>
      d.carat_number != null && d.carat_number >= criteria.carat_min && d.carat_number <= criteria.carat_max &&
      d.ratio_number != null && d.ratio_number >= criteria.ratio_min && d.ratio_number <= criteria.ratio_max &&
      d.depth_number != null && d.depth_number < criteria.depth_max &&
      d.table_number != null && d.table_number >= criteria.table_min && d.table_number <= criteria.table_max &&
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
  await page.screenshot({ path: "screen-success.png", fullPage: true });
} catch (error) {
  console.error("Diamond screen failed:", error);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
    success: false,
    checked_at: new Date().toISOString(),
    requested_at: request.requested_at || null,
    criteria,
    error: error.message
  }, null, 2));
  try { await page.screenshot({ path: "screen-failure.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await context.close();
}
