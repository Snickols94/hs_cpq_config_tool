import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

// READ: list all products (unchanged; used elsewhere/debugging).
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("products").collect();
  },
});

// READ: only configurable PARENT products — what the picker should show.
// Parts (isConfigurable false/absent) are options, not separately configurable.
export const listConfigurable = query({
  args: {},
  handler: async (ctx) => {
    const configurable = await ctx.db
      .query("products")
      .withIndex("by_configurable", (q) => q.eq("isConfigurable", true))
      .collect();
    return configurable.map((p) => ({ _id: p._id, name: p.name }));
  },
});

// WRITE: add a product (unchanged).
export const add = internalMutation({
  args: {
    name: v.string(),
    hubspotProductId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("products", {
      name: args.name,
      hubspotProductId: args.hubspotProductId,
    });
  },
});
