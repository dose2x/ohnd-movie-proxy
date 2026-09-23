const ALLOWED_ORIGINS = new Set([
  "https://dose2x.github.io",
  "http://localhost:4173",
]);

const MAX_TITLE_LENGTH = 200;
const UPSTREAM_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // results rarely change; saves OMDb quota on repeat searches
const CACHE_MAX_ENTRIES = 500;

function corsHeaders(origin) {
  const headers = { "Content-Type": "application/json" };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResponse(body, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), ...extraHeaders },
  });
}

function errorResponse(message, status, origin) {
  return jsonResponse({ Response: "False", Error: message }, status, origin);
}

// Per-isolate memory cache. Not shared across Cloudflare locations, but it
// absorbs repeat searches during a race night without touching OMDb or RT.
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

const RT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html",
};

const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// "Grey's Anatomy" / "Grey&#39;s Anatomy" / "Law & Order" / "Law and Order" all compare equal.
function norm(s) {
  return decodeEntities(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

// OMDb years look like "2010", "2008–2013" or "2019–"; RT wants the first year.
function firstYear(y) {
  const m = String(y || "").match(/\d{4}/);
  return m ? m[0] : "";
}

// OMDb frequently has no Rotten Tomatoes rating for TV series, shorts, and
// less mainstream titles. When that happens, fall back to RT's own search
// page: it server-renders results with the Tomatometer score already in the
// HTML, so no headless browser or private API is needed. Movie rows use the
// attribute "tomatometer-score"; TV rows use "tomatometerscore" (no hyphen) -
// RT is inconsistent about this between the two result types.
async function findRottenTomatoesScore(title, year, mediaType) {
  try {
    const searchUrl = `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`;
    const res = await fetch(searchUrl, { headers: RT_HEADERS, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) return null;
    const html = await res.text();

    const preferredPath = mediaType === "series" || mediaType === "episode" ? "/tv/" : "/m/";
    const rowRegex = /<search-page-media-row([^>]*)>([\s\S]*?)<\/search-page-media-row>/gi;
    const candidates = [];
    let match;

    while ((match = rowRegex.exec(html)) !== null) {
      const attrs = match[1];
      const inner = match[2];

      const scoreAttr = attrs.match(/tomatometer-?score="(\d*)"/i);
      if (!scoreAttr || !scoreAttr[1]) continue;

      const hrefMatch = inner.match(/href="https:\/\/www\.rottentomatoes\.com(\/(?:m|tv)\/[^"]+)"/i);
      if (!hrefMatch) continue;

      const nameMatch = inner.match(/alt="([^"]+)"/i);
      const yearMatch = attrs.match(/(?:release-?year|startyear)="(\d*)"/i);

      candidates.push({
        score: scoreAttr[1],
        path: hrefMatch[1],
        url: `https://www.rottentomatoes.com${hrefMatch[1]}`,
        name: nameMatch ? nameMatch[1] : "",
        year: yearMatch ? yearMatch[1] : "",
      });
    }

    const wantedName = norm(title);
    const wantedYear = firstYear(year);
    const sameType = (c) => c.path.startsWith(preferredPath);
    const nameEq = (c) => norm(c.name) === wantedName;
    // "Gran Turismo" -> "Gran Turismo: Based on a True Story"
    const namePrefix = (c) => norm(c.name).startsWith(wantedName);
    const yearKnownEq = (c) => Boolean(wantedYear && c.year) && c.year === wantedYear;
    const yearOk = (c) => !wantedYear || !c.year || c.year === wantedYear;

    // Only accept a result that is clearly the same title. Showing no RT score
    // is better than showing a different movie's score.
    const pick =
      candidates.find((c) => sameType(c) && nameEq(c) && yearOk(c)) ||
      candidates.find((c) => nameEq(c) && yearKnownEq(c)) ||
      candidates.find((c) => sameType(c) && namePrefix(c) && yearKnownEq(c));

    return pick ? { value: `${pick.score}%`, url: pick.url } : null;
  } catch (err) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          ...corsHeaders(origin),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "GET") {
      return errorResponse("Method not allowed.", 405, origin);
    }

    // Stops other websites' browsers, but a script can fake the Origin header,
    // so the per-IP rate limit below is what actually protects the OMDb quota.
    if (!ALLOWED_ORIGINS.has(origin)) {
      return errorResponse("Origin not allowed.", 403, origin);
    }

    const url = new URL(request.url);
    const title = (url.searchParams.get("t") || "").trim();
    if (!title) {
      return errorResponse("Missing title.", 400, origin);
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return errorResponse("Title is too long.", 400, origin);
    }

    const cacheKey = title.toLowerCase();
    const cached = cacheGet(cacheKey);
    if (cached) {
      return jsonResponse(cached, 200, origin, { "Cache-Control": "public, max-age=3600", "X-Proxy-Cache": "HIT" });
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return errorResponse("Too many searches. Wait a minute and try again.", 429, origin);
      }
    }

    let data;
    try {
      const omdbUrl = `https://www.omdbapi.com/?apikey=${env.OMDB_API_KEY}&t=${encodeURIComponent(title)}&plot=full`;
      const omdbRes = await fetch(omdbUrl, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      data = await omdbRes.json();
    } catch (err) {
      // Timeout, network failure, or a non-JSON error page from OMDb.
      return errorResponse("Movie service is unavailable. Try again shortly.", 502, origin);
    }

    if (data.Response === "True") {
      const ratings = Array.isArray(data.Ratings) ? data.Ratings : [];
      const hasRT = ratings.some((r) => r.Source === "Rotten Tomatoes");
      if (!hasRT) {
        const fallback = await findRottenTomatoesScore(data.Title || title, data.Year, data.Type);
        if (fallback) {
          ratings.push({ Source: "Rotten Tomatoes", Value: fallback.value });
          data.Ratings = ratings;
          data.RottenTomatoesFallback = true;
        }
      }
      cacheSet(cacheKey, data);
      return jsonResponse(data, 200, origin, { "Cache-Control": "public, max-age=3600" });
    }

    // "Movie not found!" is a normal 200 from OMDb. Quota/key problems
    // ("Request limit reached!", "Invalid API key!") must not be cached.
    const notFound = /not found/i.test(data.Error || "");
    return jsonResponse(data, notFound ? 200 : 502, origin);
  },
};
