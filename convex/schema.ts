import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Sellable items, synced from HubSpot.
  // Two roles live in this one table:
  //   - PARENT: a configurable end product (e.g. a laptop). isConfigurable = true.
  //   - PART:   a component that appears as an OPTION under a parent. isConfigurable = false/absent.
  // A part points at its parent via parentProductId (resolved from the HubSpot
  // `config_parent` Record ID during sync).
  products: defineTable({
    name: v.string(),
    hubspotProductId: v.optional(v.string()),

    // Role + linkage
    isConfigurable: v.optional(v.boolean()), // true => this is a parent/end product
    parentProductId: v.optional(v.id("products")), // set on PARTS: which parent they belong to

    // Reference copy of the HubSpot price. The engine/cost panel read price from
    // options.price (see below); this is stored for reference/debugging only.
    price: v.optional(v.number()),

    // Convex-side audit mirror. HubSpot holds the authoritative audit fields
    // (configurator_sync_status / _error_message); these mirror them so the tool
    // is self-describing and debuggable without opening HubSpot.
    syncStatus: v.optional(v.string()), // "Processing" | "Warning" | "Error" | "Synced"
    syncError: v.optional(v.string()),
    // Persisted config facts (so rebuild can read them from the DB, not just
    // the sync batch — makes single-item sync safe).
    configGroup: v.optional(v.string()),
    configRequired: v.optional(v.boolean()),
    configSelection: v.optional(
      v.union(v.literal("single"), v.literal("multi")),
    ),
    configExcludes: v.optional(v.array(v.string())),
    configRequires: v.optional(v.array(v.string())),
    configRequiresOneOf: v.optional(v.array(v.string())),
  })
    .index("by_hubspot_id", ["hubspotProductId"])
    .index("by_parent", ["parentProductId"])
    .index("by_configurable", ["isConfigurable"]),

  // Configurable slots on a PARENT product, e.g. "GPU", "RAM".
  optionGroups: defineTable({
    productId: v.id("products"), // the PARENT this group belongs to
    name: v.string(),
    selectionType: v.union(v.literal("single"), v.literal("multi")),
    required: v.boolean(),
  }).index("by_product", ["productId"]),

  // The choices inside a group. Each option references the PART product it sells.
  options: defineTable({
    groupId: v.id("optionGroups"),
    productId: v.id("products"), // the PART product this option represents
    name: v.string(),
    sku: v.optional(v.string()),
    price: v.optional(v.number()),
  })
    .index("by_group", ["groupId"])
    // Lets sync find "the option representing part X under parent Y" when
    // resolving config_excludes (which are authored as part Record IDs).
    .index("by_product", ["productId"]),

  // Constraints between options. The engine's core input.
  rules: defineTable({
    productId: v.id("products"), // the PARENT the rule is scoped to
    type: v.union(
      v.literal("requires"),
      v.literal("excludes"),
      v.literal("requiresOneOf"),
      v.literal("impliesValue"),
    ),
    whenOptionId: v.id("options"),
    thenOptionId: v.optional(v.id("options")), // requires / excludes / impliesValue
    thenOptionIds: v.optional(v.array(v.id("options"))), // requiresOneOf
  }).index("by_product", ["productId"]),
});
