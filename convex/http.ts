// convex/http.ts
// Public HTTP endpoint that lets the HubSpot app (via its serverless function)
// trigger a product sync. Gated by a shared secret so only the app can call it.
// Served at:  https://<deployment>.convex.site/sync
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/sync",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.SYNC_SHARED_SECRET;
    const provided = request.headers.get("x-sync-secret");
    if (!secret || provided !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // syncProducts is internal; only this gated endpoint (and the dashboard)
    // can invoke it.
    const result = await ctx.runAction(internal.hubspot.syncProducts, {});
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
