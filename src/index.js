const ALLOWED_ORIGINS = new Set([
  "https://dose2x.github.io",
  "http://localhost:4173",
]);

function corsHeaders(origin) {
  const headers = { "Content-Type": "application/json" };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

const RT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html",
};

function norm(s) {
  return (s || "").toLowerCase().trim();
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
    const res = await fetch(searchUrl, { headers: RT_HEADERS });
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

    if (!candidates.length) return null;

    const wantedName = norm(title);
    const sameType = (c) => c.path.startsWith(preferredPath);
    const nameEq = (c) => norm(c.name) === wantedName;
    const yearEq = (c) => !year || !c.year || c.year === String(year);

    const pick =
      candidates.find((c) => sameType(c) && nameEq(c) && yearEq(c)) ||
      candidates.find((c) => sameType(c) && nameEq(c)) ||
      candidates.find((c) => nameEq(c)) ||
      candidates.find((c) => sameType(c)) ||
      candidates[0];

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

    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ Response: "False", Error: "Origin not allowed." }), {
        status: 403,
        headers: corsHeaders(origin),
      });
    }

    const url = new URL(request.url);
    const title = url.searchParams.get("t");
    if (!title) {
      return new Response(JSON.stringify({ Response: "False", Error: "Missing title." }), {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    const omdbUrl = `https://www.omdbapi.com/?apikey=${env.OMDB_API_KEY}&t=${encodeURIComponent(title)}&plot=full`;
    const omdbRes = await fetch(omdbUrl);

    let data;
    try {
      data = await omdbRes.json();
    } catch (err) {
      return new Response(await omdbRes.text(), {
        status: omdbRes.status,
        headers: corsHeaders(origin),
      });
    }

    if (data.Response !== "False") {
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
    }

    return new Response(JSON.stringify(data), {
      status: omdbRes.status,
      headers: corsHeaders(origin),
    });
  },
};
