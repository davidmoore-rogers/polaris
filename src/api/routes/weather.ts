/**
 * src/api/routes/weather.ts — Status Map weather proxy endpoints
 *
 * Three read-only GETs backing the Status Map widget's weather overlay
 * (public weather data; no permission key beyond the session/token gate on
 * the main router — and the dash listener's readonly identity):
 *   GET /weather/frames               — RainViewer radar frame list { frames: [{ id, time }] }
 *   GET /weather/radar/:frame/:z/:x/:y — one radar tile PNG (proxied + cached)
 *   GET /weather/temp?lat=&lng=       — current °F at a coordinate { temperature }
 *
 * The widget tries these first and falls back to fetching RainViewer /
 * Open-Meteo directly when they fail (see siteMap.js loadRadar/loadTemps),
 * so handlers here fail fast with 502 rather than retrying upstream.
 *
 * Mounted on BOTH the main API router (session/token callers) and the Dash
 * wallboard listener (prefix-allowlisted, own generous rate limiter — one
 * radar refresh is hundreds of small tile GETs).
 */

import { Router } from "express";
import { z } from "zod";
import { getRadarFrames, getRadarTile, getTemperature } from "../../services/weatherProxyService.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

const TileParamsSchema = z.object({
  frame: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  z: z.coerce.number().int(),
  x: z.coerce.number().int(),
  y: z.coerce.number().int(),
});

const TempQuerySchema = z.object({
  lat: z.coerce.number(),
  lng: z.coerce.number(),
});

router.get("/frames", async (_req, res, next) => {
  try {
    res.json(await getRadarFrames());
  } catch (err) {
    next(err);
  }
});

router.get("/radar/:frame/:z/:x/:y", async (req, res, next) => {
  try {
    const parsed = TileParamsSchema.safeParse(req.params);
    if (!parsed.success) throw new AppError(400, "Invalid radar tile request");
    const { frame, z: zoom, x, y } = parsed.data;
    const tile = await getRadarTile(frame, zoom, x, y);
    // Frame ids are content hashes — the tile can never change, so let the
    // browser cache it hard. Overrides the dash listener's blanket no-store.
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Content-Type", "image/png");
    res.send(tile);
  } catch (err) {
    next(err);
  }
});

router.get("/temp", async (req, res, next) => {
  try {
    const parsed = TempQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "lat and lng are required numbers");
    res.json(await getTemperature(parsed.data.lat, parsed.data.lng));
  } catch (err) {
    next(err);
  }
});

export default router;
