import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const REQUEST_FILE = "screen-request.json";
const OUTPUT_FILE = "screen-results.json";
if (!fs.existsSync(REQUEST_FILE)) throw new Error(`${REQUEST_FILE} is missing.`);
const request = JSON.parse(fs.readFileSync(REQUEST_FILE, "utf8"));

function list(value, fallback) {
  const source = value ?? fallback;
  return (Array.isArray(source) ? source : [source]).map(v => String(v).trim().toUpperCase()).filter(Boolean);
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function price(value) { return num(value) ?? Number.POSITIVE_INFINITY; }
function norm(value) { return value == null ? "" : String(value).trim().toUpperCase(); }
function quality(value, field) {
  const v = norm(value);
  const aliases = {
    polish: { EXCELLENT: "EX", EX: "EX", "VERY GOOD": "VG", VERYGOOD: "VG", VG: "VG" },
    symmetry: { EXCELLENT: "EX", EX: "EX", "VERY GOOD": "VG", VERYGOOD: "VG", VG: "VG" },
    fluorescence: { FNO: "FNO", NO: "FNO", NONE: "FNO", "NO FLUORESCENCE": "FNO", FAINT: "FNT", FNT: "FNT", MEDIUM: "MED", MED: "MED", STRONG: "STR", STR: "STR" }
  };
  return aliases[field]?.[v] ?? v;
}
function allowed(value, wanted, field = null) {
  if (!wanted?.length) return true;
  const actual = field ? quality(value, field) : norm(value);
  const options = field ? wanted.map(v => quality(v, field)) : wanted.map(norm);
  return options.includes(actual);
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
  colors: list(request.colors ?? request.color, ["D", "E"]),
  clarities: list(request.clarities ?? request.clarity, ["FL", "IF", "VVS1", "VVS2"]),
  certificates: list(request.certificates ?? request.certificate, ["IGI"]),
  polish: list(request.polish, ["EX"]),
  symmetry: list(request.symmetry, ["EX"]),
  fluorescence: list(request.fluorescence, ["FNO"])
};

const PRODUCT_URL = "https://www.diamondsfactory.ca/design/hidden-halo-diamond-engagement-rings-clrn0757601?metal_purity=PL_950_W&ring_size=R15_7&stone_shape=OVL&stone_type=LAB&store_id=6";
const LAZYLOAD_URL = "https://www.diamondsfactory.ca/index.php?route=product/product/lazyloadDiamond";
const PROFILE_DIR = process.platform === "win32" ? "C:\\diamond-price-checker-profile" : path.resolve("./chrome-profile");

function payload(pageNumber, color, clarity) {
  const p = new URLSearchParams();
  p.set("stone_shape", "OVL");
  p.set("stone_carat_min", criteria.carat_min.toFixed(2));
  p.set("stone_carat_max", criteria.carat_max.toFixed(2));
  p.set("stone_clarity", clarity);
  p.set("stone_intensity", "");
  p.set("stone_color", color);
  p.set("stone_certificate", criteria.certificates.length === 1 ? criteria.certificates[0] : "");
  p.set("stone_cut", "");
  p.set("stone_polish", criteria.polish.length === 1 ? criteria.polish[0] : "");
  p.set("stone_symmetry", criteria.symmetry.length === 1 ? criteria.symmetry[0] : "");
  p.set("stone_fluorescence", criteria.fluorescence.length === 1 ? criteria.fluorescence[0] : "");
  p.set("stone_price_min", String(criteria.price_min));
  p.set("stone_price_max", String(criteria.price_max));
  p.set("show_image", ""); p.set("show_video", ""); p.set("show_instock", ""); p.set("show_heart_arrows", "");
  p.set("markup", ""); p.set("tax_class_id", "10"); p.set("design_id", "49"); p.set("image_stone", "di"); p.set("side_stone", "");
  p.set("metal_purity", "PL_950_W"); p.set("product_id", "15102"); p.set("ring_size", "R15_7"); p.set("active_diamond_tab", "LAB");
  p.set("diamond_code", ""); p.set("edit_product", ""); p.set("order", "asc"); p.set("search", ""); p.set("carat_skip", ""); p.set("colored_stone_type", "");
  p.set("page", String(pageNumber));
  return p;
}

function normalize(stone) {
  return {
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
    carat_number: num(stone.weight ?? stone.caratweight),
    ratio_number: num(stone.ratio),
    depth_number: num(stone.depth),
    table_number: num(stone.table),
    price_number: price(stone.csprice ?? stone.price)
  };
}

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome", headless: false, viewport: { width: 1440, height: 1000 }, locale: "en-CA", timezoneId: "America/Toronto"
});
const pages = context.pages();
const page = pages.length ? pages[0] : await context.newPage();

try {
  console.log("Opening Diamonds Factory product page...");
  console.log("Criteria:", criteria);
  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);

  const body = await page.locator("body").innerText().catch(() => "");
  if (body.includes("Sorry, you have been blocked") || body.includes("You are unable to access diamondsfactory.ca")) throw new Error("Diamonds Factory presented a Cloudflare block page.");
  try {
    const b = page.locator("#onetrust-accept-btn-handler");
    if (await b.isVisible({ timeout: 1500 }).catch(() => false)) await b.click();
  } catch {}

  const stonesByCode = new Map();
  const scans = [];
  const MAX_PAGES_PER_COMBO = 100;

  for (const color of criteria.colors) {
    for (const clarity of criteria.clarities) {
      let comboTotal = null;
      let comboPages = 0;
      let comboUnique = 0;
      let complete = false;

      for (let pageNumber = 1; pageNumber <= MAX_PAGES_PER_COMBO; pageNumber++) {
        comboPages = pageNumber;
        const body = payload(pageNumber, color, clarity).toString();
        const response = await page.evaluate(async ({ url, body }) => {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
            credentials: "include",
            body
          });
          return { ok: r.ok, status: r.status, text: await r.text() };
        }, { url: LAZYLOAD_URL, body });

        if (!response.ok) throw new Error(`lazyloadDiamond returned HTTP ${response.status} for ${color}/${clarity}, page ${pageNumber}.`);
        let json;
        try { json = JSON.parse(response.text); }
        catch { throw new Error(`lazyloadDiamond did not return JSON for ${color}/${clarity}, page ${pageNumber}.`); }

        if (comboTotal === null) comboTotal = num(json.stone_total);
        const stones = Array.isArray(json.stones) ? json.stones : [];
        let newThisPage = 0;
        for (const stone of stones) {
          const d = normalize(stone);
          if (!d.diamond_code) continue;
          if (d.price_number < criteria.price_min || d.price_number > criteria.price_max) continue;
          if (!stonesByCode.has(d.diamond_code)) {
            stonesByCode.set(d.diamond_code, d);
            newThisPage += 1;
            comboUnique += 1;
          }
        }

        if (stones.length === 0 || (comboTotal !== null && pageNumber * 10 >= comboTotal)) {
          complete = true;
          break;
        }
        if (newThisPage === 0 && stones.every(s => price(s.csprice ?? s.price) > criteria.price_max)) {
          complete = true;
          break;
        }
      }

      scans.push({ color, clarity, reported_total: comboTotal, pages: comboPages, unique_added: comboUnique, complete });
      if (!complete) throw new Error(`Server-filtered scan for ${color}/${clarity} exceeded ${MAX_PAGES_PER_COMBO} pages.`);
    }
  }

  const normalized = [...stonesByCode.values()];
  const geometryMatches = normalized.filter(d =>
    d.carat_number !== null && d.carat_number >= criteria.carat_min && d.carat_number <= criteria.carat_max &&
    d.ratio_number !== null && d.ratio_number >= criteria.ratio_min && d.ratio_number <= criteria.ratio_max &&
    d.depth_number !== null && d.depth_number < criteria.depth_max &&
    d.table_number !== null && d.table_number >= criteria.table_min && d.table_number <= criteria.table_max
  );

  const matches = geometryMatches.filter(d =>
    allowed(d.color, criteria.colors) &&
    allowed(d.clarity, criteria.clarities) &&
    allowed(d.certificate, criteria.certificates) &&
    allowed(d.polish, criteria.polish, "polish") &&
    allowed(d.symmetry, criteria.symmetry, "symmetry") &&
    allowed(d.fluorescence, criteria.fluorescence, "fluorescence")
  ).sort((a, b) => a.price_number - b.price_number);

  const result = {
    success: true,
    checked_at: new Date().toISOString(),
    requested_at: request.requested_at || null,
    source: "Diamonds Factory Canada",
    currency: "CAD",
    criteria,
    server_filtered_scans: scans,
    inventory_stones_found_within_budget_and_quality: normalized.length,
    geometry_match_count: geometryMatches.length,
    match_count: matches.length,
    matches
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2));
  fs.writeFileSync("screen-debug-response.json", JSON.stringify(scans, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({ path: "screen-success.png", fullPage: true });
} catch (error) {
  console.error("Diamond screen failed:", error);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ success: false, checked_at: new Date().toISOString(), requested_at: request.requested_at || null, criteria, error: error.message }, null, 2));
  try { await page.screenshot({ path: "screen-failure.png", fullPage: true }); } catch {}
  process.exitCode = 1;
} finally {
  await context.close();
}
