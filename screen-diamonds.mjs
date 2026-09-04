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
  price_min: Number(request.price_min ?? 100),
  price_max: Number(request.price_max ?? 3000),
  ratio_min: Number(request.ratio_min ?? 1.3),
  ratio_max: Number(request.ratio_max ?? 1.5),
  depth_max: Number(request.depth_max ?? 63),
  table_min: Number(request.table_min ?? 53),
  table_max: Number(request.table_max ?? 58),
  shape: String(request.shape ?? "Oval"),
  stone_type: String(request.stone_type ?? "Lab-grown"),
  colors: stringList(request.colors ?? request.color, ["D", "E"]),
  clarities: stringList(request.clarities ?? request.clarity, ["FL", "IF", "VVS1", "VVS2"]),
  certificates: stringList(request.certificates ?? request.certificate, ["IGI"]),
  polish: stringList(request.polish, ["EX"]),
  symmetry: stringList(request.symmetry, ["EX"]),
  fluorescence: stringList(request.fluorescence, ["FNO"])
};

const PRODUCT_URL =
  "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601" +
  "?metal_purity=PL_950_W&ring_size=R15_7&stone_shape=OVL&stone_type=LAB&store_id=6";

const LAZYLOAD_URL =
  "https://www.diamondsfactory.ca/index.php?route=product/product/lazyloadDiamond";

const PROFILE_DIR = process.platform === "win32"
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
  return value === null || value === undefined ? "" : String(value).trim().toUpperCase();
}

function normalizeQuality(value, field) {
  const v = normalizeText(value);
  const aliases = {
    polish: { EXCELLENT: "EX", EX: "EX", "VERY GOOD": "VG", VERYGOOD: "VG", VG: "VG" },
    symmetry: { EXCELLENT: "EX", EX: "EX", "VERY GOOD": "VG", VERYGOOD: "VG", VG: "VG" },
    fluorescence: {
      FNO: "FNO", NO: "FNO", NONE: "FNO", "NO FLUORESCENCE": "FNO",
      FAINT: "FNT", FNT: "FNT", MEDIUM: "MED", MED: "MED",
      STRONG: "STR", STR: "STR", "VERY STRONG": "VST", VST: "VST"
    }
  };
  return aliases[field]?.[v] ?? v;
}

function matchesAllowed(value, allowed, field = null) {
  if (!allowed || allowed.length === 0) return true;
  const actual = field ? normalizeQuality(value, field) : normalizeText(value);
  const wanted = field ? allowed.map(v => normalizeQuality(v, field)) : allowed.map(normalizeText);
  return wanted.includes(actual);
}

function buildPayload(pageNumber) {
  const p = new URLSearchParams();
  p.set("stone_shape", "OVL");
  p.set("stone_carat_min", criteria.carat_min.toFixed(2));
  p.set("stone_carat_max", criteria.carat_max.toFixed(2));
  p.set("stone_clarity", "");
  p.set("stone_intensity", "");
  p.set("stone_color", "");
  p.set("stone_certificate", "");
  p.set("stone_cut", "");
  p.set("stone_polish", "");
  p.set("stone_symmetry", "");
  p.set("stone_fluorescence", "");
  p.set("stone_price_min", String(criteria.price_min));
  p.set("stone_price_max", String(criteria.price_max));
  p.set("show_image", "");
  p.set("show_video", "");
  p.set("show_instock", "");
  p.set("show_heart_arrows", "");
  p.set("markup", "");
  p.set("tax_class_id", "10");
  p.set("design_id", "49");
  p.set("image_stone", "di");
  p.set("side_stone", "");
  p.set("metal_purity", "PL_950_W");
  p.set("product_id", "15102");
  p.set("ring_size", "R15_7");
  p.set("active_diamond_tab", "LAB");
  p.set("diamond_code", "");
  p.set("edit_product", "");
  p.set("order", "asc");
  p.set("search", "");
  p.set("carat_skip", "");
  p.set("colored_stone_type", "");
  p.set("page", String(pageNumber));
  return p;
}

function distribution(items, getter) {
  const counts = {};
  for (const item of items) {
    const key = String(getter(item) ?? "<null>");
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
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
  console.log("Opening Diamonds Factory product page...");
  console.log("Criteria:", criteria);
  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (bodyText.includes("Sorry, you have been blocked") || bodyText.includes("You are unable to access diamondsfactory.ca")) {
    throw new Error("Diamonds Factory presented a Cloudflare block page.");
  }

  try {
    const cookieButton = page.locator("#onetrust-accept-btn-handler");
    if (await cookieButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cookieButton.click();
      await page.waitForTimeout(500);
    }
  } catch {}

  const allStones = [];
  const seenCodes = new Set();
  const debugPages = [];
  let expectedTotal = null;
  let firstPayload = null;
  let paginationComplete = false;
  const MAX_PAGES = 500;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const payload = buildPayload(pageNumber);
    if (!firstPayload) firstPayload = payload.toString();

    const response = await page.evaluate(async ({ url, body }) => {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        },
        credentials: "include",
        body
      });
      return { status: r.status, ok: r.ok, text: await r.text() };
    }, { url: LAZYLOAD_URL, body: payload.toString() });

    if (!response.ok) throw new Error(`lazyloadDiamond returned HTTP ${response.status} on page ${pageNumber}.`);

    let json;
    try {
      json = JSON.parse(response.text);
    } catch {
      fs.writeFileSync("screen-debug-response.txt", response.text);
      throw new Error(`lazyloadDiamond did not return JSON on page ${pageNumber}.`);
    }

    if (expectedTotal === null) {
      expectedTotal = parseNumber(json.stone_total);
      console.log(`Diamonds Factory reports ${expectedTotal ?? "unknown"} total stones within the requested price range.`);
    }

    const stones = Array.isArray(json.stones) ? json.stones : [];
    let newCodesThisPage = 0;
    for (const stone of stones) {
      const code = stone?.diamond_code ? String(stone.diamond_code) : null;
      if (!code || seenCodes.has(code)) continue;
      seenCodes.add(code);
      allStones.push(stone);
      newCodesThisPage += 1;
    }

    debugPages.push({
      page: pageNumber,
      stone_count: stones.length,
      new_codes: newCodesThisPage,
      cumulative_unique: allStones.length,
      reported_total: expectedTotal
    });

    console.log(`Inventory page ${pageNumber}: ${stones.length} stones, ${allStones.length}/${expectedTotal ?? "?"} unique collected`);

    if (expectedTotal !== null && allStones.length >= expectedTotal) {
      paginationComplete = true;
      break;
    }
    if (stones.length === 0 || newCodesThisPage === 0) {
      paginationComplete = true;
      break;
    }
  }

  fs.writeFileSync("screen-debug-request.txt", firstPayload || "");
  fs.writeFileSync("screen-debug-response.json", JSON.stringify(debugPages, null, 2));
  fs.writeFileSync("screen-debug-raw-stones.json", JSON.stringify(allStones.slice(0, 50), null, 2));

  if (allStones.length === 0) throw new Error("lazyloadDiamond returned no stones.");
  if (!paginationComplete) {
    throw new Error(`Inventory scan hit the ${MAX_PAGES}-page safety limit before completion (${allStones.length}/${expectedTotal ?? "unknown"} stones). Refusing to report incomplete screening results.`);
  }

  const normalized = allStones.map(stone => ({
    diamond_code: stone.diamond_code ?? null,
    stone_id: stone.stone_price_id ?? stone.stoneid ?? null,
    price: stone.csprice ?? stone.price ?? null,
    carat: stone.weight ?? stone.caratweight ?? null,
    color: stone.color ?? null,
    clarity: stone.clarity ?? null,
    certificate: stone.lab ?? null,
    certificate_number: stone.cert ?? null,
    cut: stone.cut ?? null,
    polish: stone.polish ?? stone.pol ?? null,
    symmetry: stone.symmetry ?? stone.symm ?? null,
    fluorescence: stone.fluorescence ?? stone.fluor ?? null,
    measurements: stone.meas ?? stone.measurements ?? null,
    ratio: stone.ratio ?? null,
    depth: stone.depth ?? null,
    table: stone.table ?? null,
    shape: stone.shape ?? null,
    image_url: stone.image_url ?? null,
    video_url: stone.video_url ?? null,
    carat_number: parseNumber(stone.weight ?? stone.caratweight),
    ratio_number: parseNumber(stone.ratio),
    depth_number: parseNumber(stone.depth),
    table_number: parseNumber(stone.table),
    price_number: priceNumber(stone.csprice ?? stone.price)
  }));

  const geometryMatches = normalized.filter(d =>
    d.price_number >= criteria.price_min && d.price_number <= criteria.price_max &&
    d.carat_number !== null && d.carat_number >= criteria.carat_min && d.carat_number <= criteria.carat_max &&
    d.ratio_number !== null && d.ratio_number >= criteria.ratio_min && d.ratio_number <= criteria.ratio_max &&
    d.depth_number !== null && d.depth_number < criteria.depth_max &&
    d.table_number !== null && d.table_number >= criteria.table_min && d.table_number <= criteria.table_max
  );

  const matches = geometryMatches.filter(d =>
    matchesAllowed(d.color, criteria.colors) &&
    matchesAllowed(d.clarity, criteria.clarities) &&
    matchesAllowed(d.certificate, criteria.certificates) &&
    matchesAllowed(d.polish, criteria.polish, "polish") &&
    matchesAllowed(d.symmetry, criteria.symmetry, "symmetry") &&
    matchesAllowed(d.fluorescence, criteria.fluorescence, "fluorescence")
  ).sort((a, b) => a.price_number - b.price_number);

  const rowsWithGeometry = normalized.filter(d => d.ratio_number !== null && d.depth_number !== null && d.table_number !== null);

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    requested_at: request.requested_at || null,
    source: "Diamonds Factory Canada",
    currency: "CAD",
    criteria,
    inventory_reported_total: expectedTotal,
    inventory_stones_found: allStones.length,
    pagination_complete: paginationComplete,
    rows_with_ratio_depth_table: rowsWithGeometry.length,
    geometry_match_count: geometryMatches.length,
    match_count: matches.length,
    matches,
    diagnostics: {
      geometry_quality_distributions: {
        color: distribution(geometryMatches, d => d.color),
        clarity: distribution(geometryMatches, d => d.clarity),
        certificate: distribution(geometryMatches, d => d.certificate),
        polish: distribution(geometryMatches, d => d.polish),
        symmetry: distribution(geometryMatches, d => d.symmetry),
        fluorescence: distribution(geometryMatches, d => d.fluorescence)
      }
    }
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
