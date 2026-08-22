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
    const body = await omdbRes.text();

    return new Response(body, {
      status: omdbRes.status,
      headers: corsHeaders(origin),
    });
  },
};
