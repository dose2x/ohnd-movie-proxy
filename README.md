# ohnd-movie-proxy

Cloudflare Worker that proxies OMDb API requests for the [OHND Movie Guide](https://github.com/dose2x/ohnd-movie-guide) and the Movie Guide tab in [OHND Race Host Game Hub](https://github.com/dose2x/ohnd-hub). It keeps the OMDb API key server-side and restricts requests to an origin allowlist (`ALLOWED_ORIGINS` in `src/index.js`).

```
browser (dose2x.github.io) → this Worker → OMDb API
```

Deployed at `https://ohnd-movie-proxy.ohndtomatometer.workers.dev`.

## Rotten Tomatoes fallback

OMDb's `Ratings` array frequently omits Rotten Tomatoes, especially for TV series, shorts, and older or less mainstream titles. When that happens, the Worker falls back to Rotten Tomatoes itself:

1. Fetch `rottentomatoes.com/search?search=<title>` — RT server-renders results with the Tomatometer score already in the HTML (`tomatometer-score="93"` for movies, `tomatometerscore="93"` for TV — RT uses inconsistent attribute naming between the two).
2. Pick the best-matching result by title, media type (movie `/m/` vs. TV `/tv/`, using OMDb's `Type` field), and release year.
3. If RT has a real Tomatometer score for that match, append it to the response's `Ratings` array as `{ Source: "Rotten Tomatoes", Value: "93%" }` and set `RottenTomatoesFallback: true` on the response.

If RT itself has no critic score for a title (not enough reviews), no fallback value is added.

This is best-effort scraping of RT's public search page, not an official API, so it can break if RT changes their markup again.

## Deploy

```
npx wrangler deploy
```

Requires the `OMDB_API_KEY` secret to be set (`npx wrangler secret put OMDB_API_KEY`).
