// convex/seed.ts
import { internalMutation } from "./_generated/server";

export const seedSampleProduct = internalMutation({
  args: {},
  handler: async (ctx) => {
    // 1. Create the product
    const productId = await ctx.db.insert("products", {
      name: "Configurable Laptop",
    });

    // 2. Create option groups
    const displayGroup = await ctx.db.insert("optionGroups", {
      productId,
      name: "Display",
      selectionType: "single",
      required: true,
    });
    const gpuGroup = await ctx.db.insert("optionGroups", {
      productId,
      name: "Graphics",
      selectionType: "single",
      required: true,
    });

    // 3. Create options
    const display4k = await ctx.db.insert("options", {
      groupId: displayGroup,
      productId,
      name: "4K Display",
    });
    const displayHd = await ctx.db.insert("options", {
      groupId: displayGroup,
      productId,
      name: "1080p Display",
    });
    const premiumGpu = await ctx.db.insert("options", {
      groupId: gpuGroup,
      productId,
      name: "Premium GPU",
    });
    const integratedGpu = await ctx.db.insert("options", {
      groupId: gpuGroup,
      productId,
      name: "Integrated GPU",
    });

    // 4. Create rules (same logic as your passing tests)
    await ctx.db.insert("rules", {
      productId,
      type: "requires",
      whenOptionId: display4k,
      thenOptionId: premiumGpu,
    });
    await ctx.db.insert("rules", {
      productId,
      type: "excludes",
      whenOptionId: premiumGpu,
      thenOptionId: integratedGpu,
    });

    return { productId };
  },
});

// One-time: set prices on existing options by name.
export const setPrices = internalMutation({
  args: {},
  handler: async (ctx) => {
    const priceByName: Record<string, number> = {
      "4K Display": 400,
      "1080p Display": 150,
      "Premium GPU": 800,
      "Integrated GPU": 0,
    };
    const options = await ctx.db.query("options").collect();
    for (const opt of options) {
      const price = priceByName[opt.name];
      if (price !== undefined) {
        await ctx.db.patch(opt._id, { price });
      }
    }
    return `Updated ${options.length} options`;
  },
});
