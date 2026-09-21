// convex/configurator.ts
import { internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { evaluate, Rule } from "./lib/configEngine";

// Load a product's groups with their options, for rendering the UI.
export const getProductStructure = query({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const groups = await ctx.db
      .query("optionGroups")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    const groupsWithOptions = [];
    for (const group of groups) {
      const options = await ctx.db
        .query("options")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      groupsWithOptions.push({
        id: group._id,
        name: group.name,
        selectionType: group.selectionType,
        options: options.map((o) => ({ id: o._id, name: o.name })),
      });
    }
    return groupsWithOptions;
  },
});

// Given a product and the user's current selections,
// load its options + rules from the DB and run the engine.
export const evaluateConfiguration = query({
  args: {
    productId: v.id("products"),
    selectedOptionIds: v.array(v.id("options")),
  },
  handler: async (ctx, args) => {
    // 1. Load all options for this product's groups.
    const groups = await ctx.db
      .query("optionGroups")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    const allOptions = [];
    for (const group of groups) {
      const opts = await ctx.db
        .query("options")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      allOptions.push(...opts);
    }

    // 2. Load all rules for this product.
    const dbRules = await ctx.db
      .query("rules")
      .withIndex("by_product", (q) => q.eq("productId", args.productId))
      .collect();

    // 3. Convert DB rows into the engine's Rule shape.
    const rules: Rule[] = dbRules.map((r) => ({
      type: r.type,
      whenOptionId: r.whenOptionId,
      thenOptionId: r.thenOptionId,
      thenOptionIds: r.thenOptionIds,
    }));

    const allOptionIds = allOptions.map((o) => o._id);
    const selectedIds = args.selectedOptionIds as string[];

    // 4. Run the pure engine — untouched from your tests.
    const result = evaluate(allOptionIds, selectedIds, rules);

    // 5. Load the parent's base price, then total = base + selected options.
    const parent = await ctx.db.get(args.productId);
    const basePrice = parent?.price ?? 0;
    const optionsTotal = allOptions
      .filter((o) => selectedIds.includes(o._id))
      .reduce((sum, o) => sum + (o.price ?? 0), 0);
    const total = basePrice + optionsTotal;

    // 5b. Completeness: every required group must have a selection.
    const requiredGroups = groups.filter((g) => g.required);
    const missingGroups: string[] = [];
    for (const group of requiredGroups) {
      const groupOptionIds = allOptions
        .filter((o) => o.groupId === group._id)
        .map((o) => o._id);
      const hasSelection = groupOptionIds.some((id) =>
        selectedIds.includes(id),
      );
      if (!hasSelection) missingGroups.push(group.name);
    }

    const isComplete = missingGroups.length === 0;
    const isValid = result.violations.length === 0;
    const canSubmit = isComplete && isValid;

    return {
      options: allOptions.map((o) => ({
        id: o._id,
        name: o.name,
        groupId: o.groupId,
        price: o.price ?? 0,
        status: result.statuses[o._id],
      })),
      violations: result.violations,
      total,
      basePrice,
      optionsTotal,
      isComplete,
      isValid,
      canSubmit,
      missingGroups,
    };
  },
});

// Resolve selected option IDs → the data needed to build HubSpot line items:
// the option's HubSpot product ID and the parent product's name.
export const resolveLineItems = internalQuery({
  args: {
    productId: v.id("products"), // the parent (configured) product
    optionIds: v.array(v.id("options")),
  },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.productId);
    const parentName = parent?.name ?? "Product";

    const items = [];
    for (const optId of args.optionIds) {
      const option = await ctx.db.get(optId);
      if (!option) continue;
      // The option points at a part product; get its HubSpot product ID.
      const partProduct = await ctx.db.get(option.productId);
      items.push({
        optionName: option.name,
        hubspotProductId: partProduct?.hubspotProductId ?? null,
        parentName,
      });
    }
    return items;
  },
});

// Resolve a parent product's own HubSpot product ID, name, and price
// (for the base line item — only added when price > 0).
export const resolveParentProduct = internalQuery({
  args: { productId: v.id("products") },
  handler: async (ctx, args) => {
    const parent = await ctx.db.get(args.productId);
    if (!parent) return null;
    return {
      name: parent.name,
      hubspotProductId: parent.hubspotProductId ?? null,
      price: parent.price ?? 0,
    };
  },
});
