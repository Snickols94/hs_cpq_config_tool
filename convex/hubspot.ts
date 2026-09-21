// convex/hubspot.ts
import {
  action,
  internalAction,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Property internal names (exactly as created in HubSpot). Change here only.
// ---------------------------------------------------------------------------
const PROPS = [
  "name",
  "price",
  "hs_sku",
  "configurable", // true => parent/end product
  "config_parent", // on a PART: Record ID of its parent
  "config_group", // group name (e.g. "GPU")
  "config_required", // "true"/"false"
  "config_selection", // "single"/"multi"
  "config_excludes", // Record IDs this part conflicts with
  "config_requires", // Record IDs this part requires (comma- or newline-separated)
  "config_requires_one_of", // Record IDs: require ONE OF these (hard, submit-blocking)
  "configurator_sync_status", // pickup queue: only "1" is processed
  "configurator_tool_item_id", // write-back target: Convex product _id
] as const;

const WRITE_STATUS = "configurator_sync_status";
const WRITE_ERROR = "configurator_sync_error_message";
const WRITE_ITEM_ID = "configurator_tool_item_id";

// Status codes (HubSpot dropdown values are the numeric strings "1".."5").
const STATUS = {
  SYNC: "1",
  PROCESSING: "2",
  WARNING: "3",
  ERROR: "4",
  SYNCED: "5",
} as const;

// ---------------------------------------------------------------------------
// HubSpot association types used by the write-back chain.
//   HUBSPOT_DEFINED = standard, cross-account.
//   USER_DEFINED    = account-specific labels created in HubSpot (HandOff §6).
// NOTE: the USER_DEFINED deal↔contact type IDs (bill/ship) are direction-
// sensitive and were captured by hand — verify in a live test. Because the
// ship/bill associations are best-effort, a wrong direction only logs; it
// never blocks the core deal + line items.
// ---------------------------------------------------------------------------
const ASSOC = {
  CONTACT_TO_COMPANY_PRIMARY: { category: "HUBSPOT_DEFINED", typeId: 1 },
  DEAL_TO_COMPANY: { category: "HUBSPOT_DEFINED", typeId: 5 },
  LINE_ITEM_TO_DEAL: { category: "HUBSPOT_DEFINED", typeId: 20 },
  CONTACT_TO_COMPANY_BILL_TO: { category: "USER_DEFINED", typeId: 1 },
  CONTACT_TO_COMPANY_SHIP_TO: { category: "USER_DEFINED", typeId: 3 },
  DEAL_TO_CONTACT_BILL_TO: { category: "USER_DEFINED", typeId: 5 },
  DEAL_TO_CONTACT_SHIP_TO: { category: "USER_DEFINED", typeId: 7 },
} as const;

// ---------------------------------------------------------------------------
// Shape passed from the action (I/O layer) into mutations (DB layer).
// ---------------------------------------------------------------------------
type RawProduct = {
  hubspotId: string;
  name: string;
  price: number;
  sku?: string;
  isConfigurable: boolean;
  configParent?: string; // parent Record ID (parts only)
  configGroup?: string;
  configRequired?: boolean;
  configSelection?: "single" | "multi";
  configExcludes: string[]; // parsed Record IDs
  configRequires: string[]; // parsed Record IDs
  configRequiresOneOf: string[]; // parsed Record IDs (require one of)
};

// Split on commas AND newlines, trim, drop empties. Works for a text field
// today and a multi-select enum later (both return a delimited string).
function parseIdList(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse one HubSpot API result row into our RawProduct.
function parseProduct(p: any): RawProduct {
  const props = p.properties ?? {};
  return {
    hubspotId: p.id,
    name: props.name ?? "(unnamed)",
    price: Number(props.price ?? 0),
    sku: props.hs_sku ?? undefined,
    isConfigurable: String(props.configurable).toLowerCase() === "true",
    configParent: props.config_parent || undefined,
    configGroup: props.config_group || undefined,
    configRequired:
      props.config_required == null
        ? undefined
        : String(props.config_required).toLowerCase() === "true",
    configSelection:
      props.config_selection === "multi"
        ? "multi"
        : props.config_selection === "single"
          ? "single"
          : undefined,
    configExcludes: parseIdList(props.config_excludes),
    configRequires: parseIdList(props.config_requires),
    configRequiresOneOf: parseIdList(props.config_requires_one_of),
  };
}

// ===========================================================================
// SYNC (action): the orchestrator. Reads HubSpot, filters the queue,
// builds structure in Convex, writes audit fields back to HubSpot.
// ===========================================================================
export const syncProducts = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    picked: number;
    parents: number;
    warnings: number;
    errors: number;
    writeBackFailures: number;
  }> => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error("HUBSPOT_TOKEN not set");

    // --- Fetch ALL products (paginated), all relevant properties. -----------
    const raw: any[] = [];
    let after: string | undefined = undefined;
    do {
      const url = new URL("https://api.hubapi.com/crm/v3/objects/products");
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", PROPS.join(","));
      if (after) url.searchParams.set("after", after);

      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok)
        throw new Error(
          `HubSpot fetch error ${res.status}: ${await res.text()}`,
        );

      const data = await res.json();
      for (const p of data.results ?? []) raw.push(p);
      after = data.paging?.next?.after;
    } while (after);

    // --- Queue filter: only status == "1" is processed. ---------------------
    const pickup = raw.filter((p) => {
      const s = p.properties?.configurator_sync_status;
      return s == null || s === "" || s === STATUS.SYNC;
    });

    const parsed = pickup.map(parseProduct);

    // --- Hand the parsed batch to the DB layer to build structure. ----------
    type OutcomeStatus = "PROCESSING" | "WARNING" | "ERROR" | "SYNCED";
    const result: {
      itemIds: Record<string, string>; // hubspotId -> convex _id
      outcomes: Record<string, { status: OutcomeStatus; message: string }>;
    } = await ctx.runMutation(internal.hubspot.applySync, { products: parsed });

    // --- Write-back pass (best-effort). -------------------------------------
    let writeBackFailures = 0;
    let warnings = 0;
    let errors = 0;

    for (const rp of parsed) {
      const outcome = result.outcomes[rp.hubspotId];
      if (!outcome) continue;
      if (outcome.status === "WARNING") warnings++;
      if (outcome.status === "ERROR") errors++;

      const body = {
        properties: {
          [WRITE_STATUS]: STATUS[outcome.status],
          [WRITE_ERROR]: outcome.message ?? "",
          [WRITE_ITEM_ID]: result.itemIds[rp.hubspotId] ?? "",
        },
      };

      try {
        const res = await fetch(
          `https://api.hubapi.com/crm/v3/objects/products/${rp.hubspotId}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          writeBackFailures++;
          console.error(
            `Write-back failed for ${rp.hubspotId}: ${res.status} ${await res.text()}`,
          );
        }
      } catch (e) {
        writeBackFailures++;
        console.error(`Write-back threw for ${rp.hubspotId}:`, e);
      }
    }

    const parents = parsed.filter((p) => p.isConfigurable).length;
    return {
      picked: parsed.length,
      parents,
      warnings,
      errors,
      writeBackFailures,
    };
  },
});

// ===========================================================================
// applySync (mutation): the DB layer. Upserts products, then rebuilds
// groups/options/rules for each parent. Reads config facts from the PERSISTED
// product rows (not the batch), so single-item sync rebuilds fully.
// ===========================================================================
export const applySync = internalMutation({
  args: {
    products: v.array(
      v.object({
        hubspotId: v.string(),
        name: v.string(),
        price: v.number(),
        sku: v.optional(v.string()),
        isConfigurable: v.boolean(),
        configParent: v.optional(v.string()),
        configGroup: v.optional(v.string()),
        configRequired: v.optional(v.boolean()),
        configSelection: v.optional(
          v.union(v.literal("single"), v.literal("multi")),
        ),
        configExcludes: v.array(v.string()),
        configRequires: v.array(v.string()),
        configRequiresOneOf: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const itemIds: Record<string, Id<"products">> = {};
    const outcomes: Record<
      string,
      { status: "PROCESSING" | "WARNING" | "ERROR" | "SYNCED"; message: string }
    > = {};
    const warn = (hsId: string, msg: string) => {
      const cur = outcomes[hsId];
      const merged = cur?.message ? `${cur.message} | ${msg}` : msg;
      const status = cur?.status === "ERROR" ? "ERROR" : "WARNING";
      outcomes[hsId] = { status, message: merged };
    };
    const err = (hsId: string, msg: string) => {
      const cur = outcomes[hsId];
      const merged = cur?.message ? `${cur.message} | ${msg}` : msg;
      outcomes[hsId] = { status: "ERROR", message: merged };
    };

    // ---- PHASE 1: upsert every product so all Record IDs have a Convex _id.
    for (const p of args.products) {
      const existing = await ctx.db
        .query("products")
        .withIndex("by_hubspot_id", (q) =>
          q.eq("hubspotProductId", p.hubspotId),
        )
        .first();

      const fields = {
        name: p.name,
        hubspotProductId: p.hubspotId,
        isConfigurable: p.isConfigurable,
        price: p.price,
        // Persist config facts so the rebuild can read them from the DB
        // (not just the batch) — this is what makes single-item sync safe.
        configGroup: p.configGroup,
        configRequired: p.configRequired,
        configSelection: p.configSelection,
        configExcludes: p.configExcludes,
        configRequires: p.configRequires,
        configRequiresOneOf: p.configRequiresOneOf,
      };

      let id: Id<"products">;
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        id = existing._id;
      } else {
        id = await ctx.db.insert("products", fields);
      }
      itemIds[p.hubspotId] = id;
      outcomes[p.hubspotId] = { status: "SYNCED", message: "" };
    }

    const resolveProductId = async (hsId: string) => {
      if (itemIds[hsId]) return itemIds[hsId];
      const row = await ctx.db
        .query("products")
        .withIndex("by_hubspot_id", (q) => q.eq("hubspotProductId", hsId))
        .first();
      return row?._id;
    };

    // ---- PHASE 2: set parentProductId on parts. ----------------------------
    for (const p of args.products) {
      if (p.isConfigurable) continue;
      if (!p.configParent) {
        err(
          p.hubspotId,
          `Part has no config_parent set; cannot attach to a configurable product.`,
        );
        continue;
      }
      const parentId = await resolveProductId(p.configParent);
      if (!parentId) {
        err(
          p.hubspotId,
          `config_parent references unknown Record ID ${p.configParent}; part not attached.`,
        );
        continue;
      }
      await ctx.db.patch(itemIds[p.hubspotId], { parentProductId: parentId });
    }

    // ---- PHASE 3: rebuild structure for each PARENT in the batch. ----------
    const parents = args.products.filter((p) => p.isConfigurable);

    for (const parent of parents) {
      const parentId = itemIds[parent.hubspotId];

      const oldRules = await ctx.db
        .query("rules")
        .withIndex("by_product", (q) => q.eq("productId", parentId))
        .collect();
      for (const r of oldRules) await ctx.db.delete(r._id);

      const oldGroups = await ctx.db
        .query("optionGroups")
        .withIndex("by_product", (q) => q.eq("productId", parentId))
        .collect();
      for (const g of oldGroups) {
        const oldOpts = await ctx.db
          .query("options")
          .withIndex("by_group", (q) => q.eq("groupId", g._id))
          .collect();
        for (const o of oldOpts) await ctx.db.delete(o._id);
        await ctx.db.delete(g._id);
      }

      const parts = await ctx.db
        .query("products")
        .withIndex("by_parent", (q) => q.eq("parentProductId", parentId))
        .collect();

      // Only used now for SKU + conflict-warning attribution.
      const parsedByConvexId = new Map<
        Id<"products">,
        (typeof args.products)[number]
      >();
      for (const bp of args.products) {
        const cid = itemIds[bp.hubspotId];
        if (cid) parsedByConvexId.set(cid, bp);
      }

      const groupBuckets = new Map<
        string,
        {
          required: boolean;
          selection: "single" | "multi";
          requiredSeen: Set<boolean>;
          selectionSeen: Set<"single" | "multi">;
          partConvexIds: Id<"products">[];
        }
      >();

      for (const part of parts) {
        // Read config facts from the PERSISTED part row (DB), not the batch.
        const groupName = part.configGroup;
        if (!groupName) {
          warn(
            part.hubspotProductId ?? part._id,
            `Part "${part.name}" has no config_group; not shown in the configurator.`,
          );
          continue;
        }

        let bucket = groupBuckets.get(groupName);
        if (!bucket) {
          bucket = {
            required: false,
            selection: "single",
            requiredSeen: new Set(),
            selectionSeen: new Set(),
            partConvexIds: [],
          };
          groupBuckets.set(groupName, bucket);
        }
        bucket.partConvexIds.push(part._id);
        if (part.configRequired != null)
          bucket.requiredSeen.add(part.configRequired);
        if (part.configSelection)
          bucket.selectionSeen.add(part.configSelection);
      }

      const optionByPartId = new Map<Id<"products">, Id<"options">>();

      for (const [groupName, bucket] of groupBuckets) {
        if (bucket.requiredSeen.size > 1) {
          bucket.required = false;
          for (const cid of bucket.partConvexIds) {
            const bp = parsedByConvexId.get(cid);
            if (bp)
              warn(
                bp.hubspotId,
                `Group "${groupName}": config_required conflict; defaulted to not-required.`,
              );
          }
        } else {
          bucket.required = bucket.requiredSeen.has(true);
        }

        if (bucket.selectionSeen.size > 1) {
          bucket.selection = "single";
          for (const cid of bucket.partConvexIds) {
            const bp = parsedByConvexId.get(cid);
            if (bp)
              warn(
                bp.hubspotId,
                `Group "${groupName}": config_selection conflict; defaulted to single.`,
              );
          }
        } else {
          bucket.selection = bucket.selectionSeen.has("multi")
            ? "multi"
            : "single";
        }

        const groupId = await ctx.db.insert("optionGroups", {
          productId: parentId,
          name: groupName,
          selectionType: bucket.selection,
          required: bucket.required,
        });

        for (const partConvexId of bucket.partConvexIds) {
          const partRow = parts.find((x) => x._id === partConvexId)!;
          const bpForSku = parsedByConvexId.get(partConvexId);
          const optionId = await ctx.db.insert("options", {
            groupId,
            productId: partConvexId,
            name: partRow.name,
            sku: bpForSku?.sku,
            price: partRow.price,
          });
          optionByPartId.set(partConvexId, optionId);
        }
      }

      // ---- PHASE 4: build excludes rules from config_excludes (from DB). ----
      for (const part of parts) {
        const excludes = part.configExcludes ?? [];
        if (excludes.length === 0) continue;

        const whenOptionId = optionByPartId.get(part._id);
        if (!whenOptionId) continue;

        for (const excludedHsId of excludes) {
          const excludedConvexId = await resolveProductId(excludedHsId);
          if (!excludedConvexId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_excludes references unknown Record ID ${excludedHsId}; rule skipped.`,
            );
            continue;
          }
          const thenOptionId = optionByPartId.get(excludedConvexId);
          if (!thenOptionId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_excludes target ${excludedHsId} is not an option under this product; rule skipped.`,
            );
            continue;
          }
          await ctx.db.insert("rules", {
            productId: parentId,
            type: "excludes",
            whenOptionId,
            thenOptionId,
          });
        }
      }

      // ---- PHASE 5: build requires rules from config_requires (from DB). ----
      for (const part of parts) {
        const requires = part.configRequires ?? [];
        if (requires.length === 0) continue;

        const whenOptionId = optionByPartId.get(part._id);
        if (!whenOptionId) continue;

        for (const requiredHsId of requires) {
          const requiredConvexId = await resolveProductId(requiredHsId);
          if (!requiredConvexId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_requires references unknown Record ID ${requiredHsId}; rule skipped.`,
            );
            continue;
          }
          const thenOptionId = optionByPartId.get(requiredConvexId);
          if (!thenOptionId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_requires target ${requiredHsId} is not an option under this product; rule skipped.`,
            );
            continue;
          }
          await ctx.db.insert("rules", {
            productId: parentId,
            type: "requires",
            whenOptionId,
            thenOptionId,
          });
        }
      }

      // ---- PHASE 6: requiresOneOf rules from config_requires_one_of. ------
      // One rule per part: "when this part is selected, one of these targets
      // must be selected too, or it is a submit-blocking violation."
      for (const part of parts) {
        const oneOf = part.configRequiresOneOf ?? [];
        if (oneOf.length === 0) continue;

        const whenOptionId = optionByPartId.get(part._id);
        if (!whenOptionId) continue;

        const thenOptionIds: Id<"options">[] = [];
        for (const targetHsId of oneOf) {
          const targetConvexId = await resolveProductId(targetHsId);
          if (!targetConvexId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_requires_one_of references unknown Record ID ${targetHsId}; target skipped.`,
            );
            continue;
          }
          const optId = optionByPartId.get(targetConvexId);
          if (!optId) {
            warn(
              part.hubspotProductId ?? part._id,
              `config_requires_one_of target ${targetHsId} is not an option under this product; target skipped.`,
            );
            continue;
          }
          thenOptionIds.push(optId);
        }

        if (thenOptionIds.length === 0) {
          warn(
            part.hubspotProductId ?? part._id,
            `config_requires_one_of on "${part.name}" resolved to no valid targets; rule skipped.`,
          );
          continue;
        }

        await ctx.db.insert("rules", {
          productId: parentId,
          type: "requiresOneOf",
          whenOptionId,
          thenOptionIds,
        });
      }
    }

    // ---- Mirror outcomes onto the Convex product rows (audit mirror). ------
    for (const p of args.products) {
      const o = outcomes[p.hubspotId];
      if (!o) continue;
      await ctx.db.patch(itemIds[p.hubspotId], {
        syncStatus:
          o.status === "PROCESSING" ? "Processing" : capitalize(o.status),
        syncError: o.message,
      });
    }

    return { itemIds, outcomes };
  },
});

// ---------------------------------------------------------------------------
// DEAL WRITE-BACK — Sub-layer 1: Company find-or-create (by domain).
// Domain is the unique key. Uses SEARCH (reliable) with a short retry to
// absorb search-index lag on very-recently-created records. Existing company
// → used untouched (no update). None after retries → create.
// ---------------------------------------------------------------------------
export const findOrCreateCompany = internalAction({
  args: {
    name: v.string(),
    domain: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ companyId: string; created: boolean }> => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error("HUBSPOT_TOKEN not set");

    const domain = args.domain.trim().toLowerCase();
    if (!domain)
      throw new Error("Company domain is required to find-or-create.");

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Search for an existing company by domain. Returns the id or null.
    const searchByDomain = async (): Promise<string | null> => {
      const res = await fetch(
        "https://api.hubapi.com/crm/v3/objects/companies/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filterGroups: [
              {
                filters: [
                  { propertyName: "domain", operator: "EQ", value: domain },
                ],
              },
            ],
            properties: ["domain", "name"],
            limit: 1,
          }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.results?.length > 0 ? data.results[0].id : null;
    };

    // Try the search a few times with short backoff to absorb index lag.
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await searchByDomain();
      if (found) return { companyId: found, created: false };
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }

    // Not found after retries → create.
    const createRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/companies",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          properties: { name: args.name.trim() || domain, domain },
        }),
      },
    );
    if (!createRes.ok) {
      throw new Error(
        `Company create failed ${createRes.status}: ${await createRes.text()}`,
      );
    }
    const created = await createRes.json();
    return { companyId: created.id, created: true };
  },
});

// ---------------------------------------------------------------------------
// DEAL WRITE-BACK — Sub-layer 2: Primary contact find-or-create (by email).
// Email is the unique key. Search + retry. Found → non-destructive update
// (only fills provided fields, never blanks, never touches email). Not found
// → create. Then associates the contact to the company when supplied.
// ---------------------------------------------------------------------------
export const findOrCreateContact = internalAction({
  args: {
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    phone: v.optional(v.string()),
    street: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    companyId: v.optional(v.string()),
    // Contact→company association labels, applied in ONE PUT. HubSpot's v4
    // PUT REPLACES the labels on a record pair, so a contact that is primary
    // AND ship/bill must receive all its labels together. Defaults to the
    // HUBSPOT_DEFINED primary (typeId 1) when omitted and a companyId is given.
    companyAssociations: v.optional(
      v.array(v.object({ category: v.string(), typeId: v.number() })),
    ),
    // Optional deal association labels (ship/bill contacts link to the deal).
    dealId: v.optional(v.string()),
    dealAssociations: v.optional(
      v.array(v.object({ category: v.string(), typeId: v.number() })),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    contactId: string;
    created: boolean;
    associated: boolean;
    dealAssociated: boolean;
  }> => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error("HUBSPOT_TOKEN not set");

    const email = args.email.trim().toLowerCase();
    if (!email) throw new Error("Contact email is required to find-or-create.");

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Build a properties object from ONLY the non-empty provided fields.
    const providedProps: Record<string, string> = {};
    const put = (key: string, val?: string) => {
      const v2 = (val ?? "").trim();
      if (v2) providedProps[key] = v2;
    };
    put("firstname", args.firstName);
    put("lastname", args.lastName);
    put("phone", args.phone);
    put("address", args.street);
    put("city", args.city);
    put("state", args.state);
    put("zip", args.zip);

    // --- Search by email (+ retry to absorb index lag). ---
    const searchByEmail = async (): Promise<string | null> => {
      const res = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filterGroups: [
              {
                filters: [
                  { propertyName: "email", operator: "EQ", value: email },
                ],
              },
            ],
            properties: ["email"],
            limit: 1,
          }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.results?.length > 0 ? data.results[0].id : null;
    };

    let contactId: string | null = null;
    let created = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      contactId = await searchByEmail();
      if (contactId) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }

    if (contactId) {
      // Found → non-destructive update (only if there's something to update).
      if (Object.keys(providedProps).length > 0) {
        const updateRes = await fetch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ properties: providedProps }),
          },
        );
        if (!updateRes.ok) {
          throw new Error(
            `Contact update failed ${updateRes.status}: ${await updateRes.text()}`,
          );
        }
      }
    } else {
      // Not found → create (email + provided fields).
      const createRes = await fetch(
        "https://api.hubapi.com/crm/v3/objects/contacts",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            properties: { email, ...providedProps },
          }),
        },
      );
      if (!createRes.ok) {
        throw new Error(
          `Contact create failed ${createRes.status}: ${await createRes.text()}`,
        );
      }
      const createdContact = await createRes.json();
      contactId = createdContact.id;
      created = true;
    }

    // --- Associate contact → company in ONE PUT (v4 replaces the label set).
    // Defaults to the HUBSPOT_DEFINED primary; callers that combine roles pass
    // the full label set (primary + ship_to/bill_to) so nothing is clobbered.
    let associated = false;
    if (args.companyId && contactId) {
      const types =
        args.companyAssociations && args.companyAssociations.length > 0
          ? args.companyAssociations
          : [{ category: "HUBSPOT_DEFINED", typeId: 1 }];
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/companies/${args.companyId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(
            types.map((t) => ({
              associationCategory: t.category,
              associationTypeId: t.typeId,
            })),
          ),
        },
      );
      if (!assocRes.ok) {
        console.error(
          `Contact→Company association failed ${assocRes.status}: ${await assocRes.text()}`,
        );
      } else {
        associated = true;
      }
    }

    // --- Optionally associate contact ↔ deal in ONE PUT (all labels together).
    // Direction: contacts→deals. Verified by live test — label type IDs 5/7 are
    // defined contact→deal, so the deals→contacts endpoint 400s (INVALID_OBJECT_IDS).
    let dealAssociated = false;
    if (
      args.dealId &&
      contactId &&
      args.dealAssociations &&
      args.dealAssociations.length > 0
    ) {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/deals/${args.dealId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(
            args.dealAssociations.map((t) => ({
              associationCategory: t.category,
              associationTypeId: t.typeId,
            })),
          ),
        },
      );
      if (!assocRes.ok) {
        console.error(
          `Deal→Contact association failed ${assocRes.status}: ${await assocRes.text()}`,
        );
      } else {
        dealAssociated = true;
      }
    }

    return { contactId: contactId!, created, associated, dealAssociated };
  },
});

// ---------------------------------------------------------------------------
// DEAL WRITE-BACK — Sub-layer 3a: Create the Deal, associate it to the Company.
// Pipeline + stage come from env vars (configurable per client).
// ---------------------------------------------------------------------------
export const createDeal = internalAction({
  args: {
    dealName: v.string(),
    amount: v.number(),
    companyId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ dealId: string; associatedCompany: boolean }> => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error("HUBSPOT_TOKEN not set");

    const pipeline = process.env.HUBSPOT_DEAL_PIPELINE || "default";
    const stage = process.env.HUBSPOT_DEAL_STAGE || "qualifiedtobuy";

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // --- Create the deal. ---
    const createRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/deals",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          properties: {
            dealname: args.dealName,
            amount: String(args.amount),
            pipeline,
            dealstage: stage,
          },
        }),
      },
    );
    if (!createRes.ok) {
      throw new Error(
        `Deal create failed ${createRes.status}: ${await createRes.text()}`,
      );
    }
    const deal = await createRes.json();
    const dealId = deal.id;

    // --- Associate deal → company (HubSpot-defined deal↔company default). ---
    let associatedCompany = false;
    if (args.companyId) {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/companies/${args.companyId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify([
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 5, // deal→company default
            },
          ]),
        },
      );
      if (!assocRes.ok) {
        console.error(
          `Deal→Company association failed ${assocRes.status}: ${await assocRes.text()}`,
        );
      } else {
        associatedCompany = true;
      }
    }

    return { dealId, associatedCompany };
  },
});

// ---------------------------------------------------------------------------
// DEAL WRITE-BACK — Sub-layer 3b: Line items.
// For each cart config: add the parent product as a line item IF it has a
// cost, then each selected option. All product-associated, HubSpot price,
// custom names with conditional tag. Batch-create, then associate to the deal.
// ---------------------------------------------------------------------------
export const addLineItemsToDeal = internalAction({
  args: {
    dealId: v.string(),
    configs: v.array(
      v.object({
        tag: v.string(),
        productId: v.id("products"),
        optionIds: v.array(v.id("options")),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    created: number;
    associated: number;
    skipped: number;
    lineItemIds: string[];
  }> => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) throw new Error("HUBSPOT_TOKEN not set");

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // Count parent-product occurrences across the cart (for tag disambiguation).
    const productCounts: Record<string, number> = {};
    for (const c of args.configs) {
      productCounts[c.productId] = (productCounts[c.productId] ?? 0) + 1;
    }

    type PendingItem = { name: string; hubspotProductId: string };
    const pending: PendingItem[] = [];
    let skipped = 0;

    for (const config of args.configs) {
      const isDuplicated = productCounts[config.productId] > 1;

      // --- Parent product as a line item, ONLY if it has a cost. ---
      const parent = await ctx.runQuery(internal.configurator.resolveParentProduct, {
        productId: config.productId,
      });
      if (parent && parent.price > 0) {
        if (parent.hubspotProductId) {
          const parentName = isDuplicated
            ? `${parent.name} - ${config.tag}`
            : parent.name;
          pending.push({
            name: parentName,
            hubspotProductId: parent.hubspotProductId,
          });
        } else {
          skipped++;
        }
      }

      // --- Each selected option as a line item. ---
      const resolved = await ctx.runQuery(internal.configurator.resolveLineItems, {
        productId: config.productId,
        optionIds: config.optionIds,
      });
      for (const item of resolved) {
        if (!item.hubspotProductId) {
          skipped++;
          continue;
        }
        const base = `${item.optionName} - ${item.parentName}`;
        const name = isDuplicated ? `${base} - ${config.tag}` : base;
        pending.push({ name, hubspotProductId: item.hubspotProductId });
      }
    }

    if (pending.length === 0) {
      return { created: 0, associated: 0, skipped, lineItemIds: [] };
    }

    // --- Batch-create line items (product-associated, HubSpot price). ---
    const batchBody = {
      inputs: pending.map((p) => ({
        properties: {
          hs_product_id: p.hubspotProductId,
          name: p.name,
          quantity: "1",
        },
      })),
    };
    const createRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/line_items/batch/create",
      { method: "POST", headers, body: JSON.stringify(batchBody) },
    );
    if (!createRes.ok) {
      throw new Error(
        `Line item batch create failed ${createRes.status}: ${await createRes.text()}`,
      );
    }
    const createdData = await createRes.json();
    const createdIds: string[] = (createdData.results ?? []).map(
      (r: any) => r.id,
    );

    // --- Associate each line item to the deal. ---
    let associated = 0;
    for (const lineItemId of createdIds) {
      const assocRes = await fetch(
        `https://api.hubapi.com/crm/v4/objects/line_items/${lineItemId}/associations/deals/${args.dealId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify([
            { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 20 },
          ]),
        },
      );
      if (assocRes.ok) associated++;
      else
        console.error(
          `Line item→Deal association failed ${assocRes.status}: ${await assocRes.text()}`,
        );
    }

    return { created: createdIds.length, associated, skipped, lineItemIds: createdIds };
  },
});

// ---------------------------------------------------------------------------
// DEAL WRITE-BACK — Orchestrator (Finalize). ONE browser call runs the whole
// chain and threads IDs through: company -> primary contact -> deal -> line
// items -> ship/bill contacts. All PII flows in as args only; nothing is
// persisted to Convex.
//
// Error model (HandOff §10.4):
//   • Deal + line items are CORE. A failure there sets `error` and returns
//     early. `dealId` is still returned if the deal was created, so a partial
//     (deal with no line items) is visible and cleanable.
//   • Company, contacts, and all associations are BEST-EFFORT: failures are
//     collected in `warnings` and never abort the run.
//
// Deal amount: HubSpot does NOT roll the amount up from line items over the
// API (verified against HubSpot docs/community, Sep 2026) — only the UI does.
// So we create line items (HubSpot owns their price), read their amounts back,
// sum them, and PATCH the deal amount to that sum. Falls back to the client
// cart total if the read-back is unavailable.
// ---------------------------------------------------------------------------
const contactValidator = v.object({
  firstName: v.string(),
  lastName: v.string(),
  email: v.string(),
  phone: v.string(),
  street: v.string(),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
});

const emailLooksValid = (e: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

type FinalizeResult = {
  ok: boolean;
  dealId: string | null;
  companyId: string | null;
  primaryContactId: string | null;
  lineItemsCreated: number;
  lineItemsSkipped: number;
  amountSet: number | null;
  warnings: string[];
  error: string | null;
};

// Sum the HubSpot `amount` of EVERY line item associated to a deal (existing +
// newly appended). Returns null when the associations or amounts can't be read,
// so the caller can choose to leave the deal amount untouched.
async function sumDealLineItems(
  dealId: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const ids: string[] = [];
    let after: string | undefined = undefined;
    do {
      const url = new URL(
        `https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items`,
      );
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) return null;
      const data = await res.json();
      for (const r of data.results ?? []) {
        const id = r.toObjectId ?? r.id;
        if (id != null) ids.push(String(id));
      }
      after = data.paging?.next?.after;
    } while (after);

    if (ids.length === 0) return 0;

    const readRes = await fetch(
      "https://api.hubapi.com/crm/v3/objects/line_items/batch/read",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          properties: ["amount"],
          inputs: ids.map((id) => ({ id })),
        }),
      },
    );
    if (!readRes.ok) return null;
    const data = await readRes.json();
    return (data.results ?? []).reduce(
      (acc: number, r: any) => acc + Number(r.properties?.amount ?? 0),
      0,
    );
  } catch {
    return null;
  }
}

export const finalizeCart = action({
  args: {
    // Omit `customer` on the UPDATE path (dealId set) — the existing deal owns
    // its company/contacts. `customer` is required to CREATE a new deal.
    customer: v.optional(
      v.object({
        company: v.optional(
          v.object({ name: v.string(), domain: v.string() }),
        ),
        primary: contactValidator,
        shipping: v.optional(contactValidator),
        billing: v.optional(contactValidator),
      }),
    ),
    configs: v.array(
      v.object({
        tag: v.string(),
        productId: v.id("products"),
        optionIds: v.array(v.id("options")),
      }),
    ),
    cartTotal: v.number(),
    dealName: v.optional(v.string()),
    // When set, APPEND to this existing deal instead of creating one.
    dealId: v.optional(v.string()),
    // Speed-bump gate. Enforced only when FINALIZE_SHARED_SECRET is set on the
    // deployment. NOT real auth (ships in the client bundle) — see HandOff §14.
    authToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<FinalizeResult> => {
    const token = process.env.HUBSPOT_TOKEN;
    const warnings: string[] = [];
    const result: FinalizeResult = {
      ok: false,
      dealId: null,
      companyId: null,
      primaryContactId: null,
      lineItemsCreated: 0,
      lineItemsSkipped: 0,
      amountSet: null,
      warnings,
      error: null,
    };

    if (!token) {
      result.error = "HUBSPOT_TOKEN is not set on the Convex deployment.";
      return result;
    }

    const finalizeSecret = process.env.FINALIZE_SHARED_SECRET;
    if (finalizeSecret && args.authToken !== finalizeSecret) {
      result.error = "Unauthorized.";
      return result;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const customer = args.customer;
    const isUpdate = !!args.dealId;

    // Get a deal to work on: the existing one (append), or a fresh one. ------
    let dealId: string;
    let companyId: string | undefined;

    if (args.dealId) {
      // UPDATE MODE — use the existing deal as-is (no stage/company/contact
      // changes). We only append line items and re-total below.
      dealId = args.dealId;
      result.dealId = dealId;
    } else {
      // CREATE MODE — needs customer info.
      if (!customer) {
        result.error =
          "No customer provided and no dealId to append to — nothing to do.";
        return result;
      }

      // Company — best-effort, only when a domain is provided.
      if (customer.company && customer.company.domain.trim()) {
        try {
          const c = await ctx.runAction(internal.hubspot.findOrCreateCompany, {
            name: customer.company.name,
            domain: customer.company.domain,
          });
          companyId = c.companyId;
          result.companyId = c.companyId;
        } catch (e) {
          warnings.push(`Company step failed: ${String(e)}`);
        }
      }

      // Deal — CORE. Amount seeded with the cart total; corrected after items.
      const dealName =
        args.dealName?.trim() ||
        `${
          customer.company?.name?.trim() ||
          `${customer.primary.firstName} ${customer.primary.lastName}`.trim() ||
          customer.primary.email
        } - ${new Date().toISOString().slice(0, 10)}`;

      try {
        const deal = await ctx.runAction(internal.hubspot.createDeal, {
          dealName,
          amount: args.cartTotal,
          companyId,
        });
        dealId = deal.dealId;
        result.dealId = deal.dealId;
        if (companyId && !deal.associatedCompany) {
          warnings.push("Deal was not associated to the company.");
        }
      } catch (e) {
        result.error = `Deal creation failed: ${String(e)}`;
        return result;
      }
    }

    // 3. Line items — CORE. APPEND only; existing lines are never altered. ---
    try {
      const li = await ctx.runAction(internal.hubspot.addLineItemsToDeal, {
        dealId,
        configs: args.configs.map((c) => ({
          tag: c.tag,
          productId: c.productId,
          optionIds: c.optionIds,
        })),
      });
      result.lineItemsCreated = li.created;
      result.lineItemsSkipped = li.skipped;
      if (li.skipped > 0) {
        warnings.push(
          `${li.skipped} line item(s) skipped (no HubSpot product ID).`,
        );
      }
    } catch (e) {
      const where = isUpdate ? "existing" : "new";
      result.error = `Line items failed (${where} deal ${dealId}): ${String(e)}`;
      return result;
    }

    // 4. Re-total: deal amount = sum of ALL line items now on the deal
    //    (existing + appended). On the update path we never patch when the read
    //    fails, so a hiccup can't wipe the prior total.
    try {
      const sum = await sumDealLineItems(dealId, headers);
      if (sum != null && sum > 0) {
        const patchRes = await fetch(
          `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ properties: { amount: String(sum) } }),
          },
        );
        if (patchRes.ok) {
          result.amountSet = sum;
        } else {
          warnings.push(`Deal amount patch failed ${patchRes.status}.`);
          if (!isUpdate) result.amountSet = args.cartTotal;
        }
      } else if (!isUpdate) {
        result.amountSet = args.cartTotal; // new deal was seeded at create
        if (sum == null) {
          warnings.push(
            "Could not read line items; deal amount left at cart total.",
          );
        }
      } else {
        warnings.push(
          "Could not recompute the deal total; left the deal amount unchanged.",
        );
      }
    } catch (e) {
      warnings.push(`Amount recompute skipped: ${String(e)}`);
      if (!isUpdate) result.amountSet = args.cartTotal;
    }

    // Contacts run in CREATE MODE ONLY — an existing deal owns its
    // company/contacts, so on the update path we stop here.
    if (isUpdate || !customer) {
      result.ok = result.error == null;
      result.warnings = warnings;
      return result;
    }

    // 5. Contacts + associations — best-effort. --------------------------
    // Dedupe by email: one person who is primary AND ship-to/bill-to becomes a
    // single HubSpot contact. Because v4 PUT REPLACES the labels on a record
    // pair, every label a pair needs is gathered here and sent in one call
    // (inside findOrCreateContact). This also means the form can set ship/bill
    // to "same as primary" (or as each other) and it just works.
    type Role = "primary" | "shipping" | "billing";
    type Contact = {
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      street: string;
      city: string;
      state: string;
      zip: string;
    };
    const byEmail = new Map<string, { data: Contact; roles: Set<Role> }>();
    const addRole = (c: Contact | undefined, role: Role) => {
      if (!c || !emailLooksValid(c.email)) return;
      const key = c.email.trim().toLowerCase();
      const existing = byEmail.get(key);
      if (existing) existing.roles.add(role);
      else byEmail.set(key, { data: c, roles: new Set<Role>([role]) });
    };
    addRole(customer.primary, "primary");
    addRole(customer.shipping, "shipping");
    addRole(customer.billing, "billing");

    const primaryKey = customer.primary.email.trim().toLowerCase();
    for (const [key, entry] of byEmail) {
      const { data, roles } = entry;

      const companyAssociations: { category: string; typeId: number }[] = [];
      if (companyId) {
        if (roles.has("primary"))
          companyAssociations.push({
            category: "HUBSPOT_DEFINED",
            typeId: ASSOC.CONTACT_TO_COMPANY_PRIMARY.typeId,
          });
        if (roles.has("shipping"))
          companyAssociations.push({
            category: "USER_DEFINED",
            typeId: ASSOC.CONTACT_TO_COMPANY_SHIP_TO.typeId,
          });
        if (roles.has("billing"))
          companyAssociations.push({
            category: "USER_DEFINED",
            typeId: ASSOC.CONTACT_TO_COMPANY_BILL_TO.typeId,
          });
      }

      const dealAssociations: { category: string; typeId: number }[] = [];
      if (roles.has("shipping"))
        dealAssociations.push({
          category: "USER_DEFINED",
          typeId: ASSOC.DEAL_TO_CONTACT_SHIP_TO.typeId,
        });
      if (roles.has("billing"))
        dealAssociations.push({
          category: "USER_DEFINED",
          typeId: ASSOC.DEAL_TO_CONTACT_BILL_TO.typeId,
        });

      try {
        const contact = await ctx.runAction(internal.hubspot.findOrCreateContact, {
          email: data.email,
          firstName: data.firstName,
          lastName: data.lastName,
          phone: data.phone,
          street: data.street,
          city: data.city,
          state: data.state,
          zip: data.zip,
          companyId,
          companyAssociations,
          dealId,
          dealAssociations,
        });
        if (key === primaryKey) result.primaryContactId = contact.contactId;
        if (
          companyId &&
          companyAssociations.length > 0 &&
          !contact.associated
        ) {
          warnings.push(
            `Contact ${data.email} was not associated to the company.`,
          );
        }
        if (dealAssociations.length > 0 && !contact.dealAssociated) {
          warnings.push(
            `Contact ${data.email} was not associated to the deal.`,
          );
        }
      } catch (e) {
        warnings.push(`Contact ${data.email} step failed: ${String(e)}`);
      }
    }

    result.ok = result.error == null;
    result.warnings = warnings;
    return result;
  },
});

// Debug: list deal pipelines + stages.
export const debugPipelines = internalAction({
  args: {},
  handler: async (): Promise<any> => {
    const token = process.env.HUBSPOT_TOKEN!;
    const res = await fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    return (data.results ?? []).map((p: any) => ({
      pipelineId: p.id,
      pipelineLabel: p.label,
      stages: (p.stages ?? []).map((s: any) => ({
        stageId: s.id,
        stageLabel: s.label,
      })),
    }));
  },
});

function capitalize(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
