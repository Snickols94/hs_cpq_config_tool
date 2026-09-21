# CPQ Configurator — Handoff (for an LLM)

Audience: an LLM resuming this build. Dense and factual. Trust the gotchas — most were found the hard way.

---

## 1. What it is

A standalone Configure-Price-Quote (CPQ) tool.

- **Config authoring lives in HubSpot.** Products carry custom properties that define groups, selection type, required-ness, and cross-product rules (excludes/requires). Non-coders edit products in HubSpot; a sync pulls those into Convex.
- **Convex** stores products/groups/options/rules and runs a pure constraint engine.
- **React + Vite UI** is a wizard: Customer Info → Product Picker → Configurator → Cart.
- **Goal end state:** the "Finalize Cart" button writes a HubSpot **Deal** with associated **Company**, **Contact(s)**, and **Line Items**.

Stack: Convex (TypeScript backend), React + Vite (frontend). HubSpot auth = **Service Key** in Convex env var `HUBSPOT_TOKEN`. Convex deployment `fine-greyhound-640` (US East). Dev box is **Windows / PowerShell**.

---

## 2. Current status

### Working + verified

- **Property-driven sync**: HubSpot products → Convex groups/options/rules. **Safe for single-item sync** (see §7 wipe bug).
- **Constraint engine** (`convex/lib/configEngine.ts`): excludes (BIDIRECTIONAL), requires, order-independence, propagation. Tested via `configEngine.test.ts`.
- **UI behaviors**: single-select enforcement, required-group narrowing (grey out non-required siblings, persists after selection), live pricing, parent base price, dark mode (CSS vars), picker shows parents only.
- **Wizard**: customer form → picker → configurator → cart. Multi-product cart with per-build tags + remove.
- **HubSpot write-back functions** (each individually runnable in the Convex dashboard):
  - `findOrCreateCompany` (by domain)
  - `findOrCreateContact` (by email; non-destructive update; applies company + deal association labels passed as `companyAssociations[]` / `dealAssociations[]`)
  - `createDeal` (creates + associates to company)
  - `addLineItemsToDeal` (parent line item if priced + option line items, associates to deal; returns `lineItemIds`)
- **Finalize is wired end-to-end** via the `finalizeCart` orchestrator — ONE browser call: company → deal → line items → amount reconcile → contacts. See §12.
- **Double-click guard shipped**: Finalize disables while sending ("Sending to HubSpot…") and after a successful send ("Sent ✓"); a result panel shows deal ID / line-item count / amount / warnings.
- **Shipping/Billing contacts (Sub-layer 4) shipped**, including **"same as primary / same as each other"** on the customer form. (The form already had email fields via the shared `ContactFields` component.)
- **Orchestrator error model shipped**: deal + line items are CORE (fail → `error` + early return, `dealId` still returned); company/contacts/associations are BEST-EFFORT (collected in `warnings`).

### NOT done (next work)

- ~~Live-test the ship/bill DEAL-association direction~~ ✅ done: labels 5/7 are contact→deal; endpoint fixed to `contacts/{id}/associations/deals/{id}` (see §6).
- **Push to the deployment**: `finalizeCart` + the extended `findOrCreateContact` are in source but must be pushed (`convex dev`/deploy) to run in `fine-greyhound-640`.
- ~~Require an email on a MANUAL ship/bill section~~ ✅ done: a "Enter separately" ship/bill section now blocks Continue until its email is valid ("same as" sources inherit the primary's email).

---

## 3. Hard rules / invariants (do not violate)

- **PII never persists in Convex.** Customer/contact data flows ONLY as action arguments, used to write HubSpot, then gone. There is NO contacts table and there must not be one. Never `ctx.db.insert/patch` any PII field.
- **HubSpot is the source of truth for prices.** Line items use HubSpot product prices (don't set price explicitly). **Deal amount does NOT roll up from line items over the API** (verified Sep 2026 — only the HubSpot UI recalculates; the API leaves `amount` alone). So `finalizeCart` seeds the deal `amount` with the cart total at create, then reads the created line items' HubSpot `amount`s back, sums them, and PATCHes the deal `amount` to that sum (cart total is the fallback). Net: deal amount == line-item sum, with HubSpot owning price.
- **Company find-or-create**: existing company (matched by domain) is used UNTOUCHED (no update). Create only if none found.
- **Contact find-or-create**: existing contact (matched by email) gets a NON-DESTRUCTIVE update — only fields the form provided, never blank an existing value, never touch email. Create if none found.
- **Company only created when a domain is provided** (domain is the dedup key). Name-only = no company. Company is optional (personal/Gmail buyers have none).
- **Configurator scope = 100% standard deals only.** Outliers are added to the deal manually by the sales rep. Do not try to encode every exception.

---

## 4. Data model (Convex schema)

`products` (one table, two roles):

- PARENT: `isConfigurable: true`, is a configurable end product.
- PART: `isConfigurable` false/absent, `parentProductId` → its parent. Appears as an option under the parent.
- Fields: `name`, `hubspotProductId`, `isConfigurable`, `parentProductId`, `price`, `syncStatus`, `syncError`, and PERSISTED config facts: `configGroup`, `configRequired`, `configSelection`, `configExcludes[]`, `configRequires[]`.
- Indexes: `by_hubspot_id`, `by_parent`, `by_configurable`.

`optionGroups`: `productId` (parent), `name`, `selectionType` (single|multi), `required`. Index `by_product`.

`options`: `groupId`, `productId` (the PART it represents), `name`, `sku`, `price`. Indexes `by_group`, `by_product`.

`rules`: `productId` (parent), `type` (requires|excludes|requiresOneOf|impliesValue), `whenOptionId`, `thenOptionId?`, `thenOptionIds?`. Index `by_product`.

Note: the config facts are persisted on PART product rows specifically so the sync rebuild can read them from the DB, not just the current batch. This is what makes single-item sync safe (§7).

---

## 5. HubSpot product properties (the authoring surface)

Set on products in HubSpot; read by sync (`PROPS` array in `convex/hubspot.ts`):

- `configurable` — "true" => parent.
- `config_parent` — on a PART: the parent's Record ID.
- `config_group` — group name (e.g. "Graphics"). Enum; internal value == label in this account.
- `config_required` — "true"/"false".
- `config_selection` — "single"/"multi".
- `config_excludes` — Record IDs this part conflicts with (comma OR newline separated; parsed by `parseIdList`).
- `config_requires` — Record IDs this part requires (same format). Creates a one-way `requires` rule (advisory: highlights the target, does NOT block submit).
- `config_requires_one_of` — Record IDs; when this part is selected, ONE OF these must also be selected or it's a **submit-blocking** violation (engine `requiresOneOf`). Same comma/newline format; parsed by `parseIdList`. **NEW (see §7). Requires a `config_requires_one_of` property in HubSpot (multi-line text or multi-select enum, same as `config_requires`).**
- `configurator_sync_status` — the pickup QUEUE. Only value "1" (label "Sync") is processed. Written back to "5" (Synced) / "3" (Warning) / "4" (Error) after sync.
- `configurator_tool_item_id` — write-back target: the Convex product `_id` is written here.
- Also written back: `configurator_sync_error_message`.

Excludes/requires reference OTHER products by **Record ID**. Future plan: convert these to multi-select enum properties whose internal value = Record ID, label = product name (no code change needed; `parseIdList` handles both).

---

## 6. HubSpot association type IDs (VERIFIED — reuse these)

All `associationCategory: "HUBSPOT_DEFINED"` unless noted:

- **Contact → Company (primary)**: `associationTypeId: 1`. VERIFIED working.
- **Deal → Company**: `associationTypeId: 5`. VERIFIED working.
- **Line Item → Deal**: `associationTypeId: 20`. VERIFIED working.

USER_DEFINED labels already created in HubSpot for Sub-layer 4 (shipping/billing), not yet used in code:

- Contact↔Company Bill-to: name `bill_to`, id 1 (USER_DEFINED)
- Contact↔Company Ship-to: name `ship_to`, id 3 (USER_DEFINED)
- Deal↔Contact Bill-to: name `bill_to_deal`, id 5 (USER_DEFINED)
- Deal↔Contact Ship-to: name `ship_to_deal`, id 7 (USER_DEFINED)
- Contact↔Company Primary: `CONTACT_TO_COMPANY`, id 1 (HUBSPOT_DEFINED)

Association model: PRIMARY contact → COMPANY only (surfaces on the deal via company→deal). SHIP-TO / BILL-TO contacts → BOTH company and deal, using the labels above.

**Implemented, with a correctness rule (see §7 v4-PUT gotcha):** `finalizeCart` dedupes contacts by email and gathers *every* label a record pair needs into ONE association PUT. One person who is primary AND ship-to/bill-to becomes a single contact carrying all labels. `findOrCreateContact` accepts `companyAssociations[]` and `dealAssociations[]` (`{category, typeId}`) for exactly this reason; the type IDs live in the `ASSOC` map at the top of `hubspot.ts`.

**Verified (live test, Sep 2026):** the deal↔contact labels 5 (bill_to_deal) / 7 (ship_to_deal) are defined in the **contact→deal** direction. The code PUTs `contacts/{id}/associations/deals/{id}`. The wrong direction (`deals/.../contacts/{id}`) 400s with `INVALID_OBJECT_IDS` (HubSpot validates the deal-position id as a CONTACT). Company labels use `contacts/{id}/associations/companies/{id}` — also confirmed working.

Deal pipeline/stage are configurable via env vars: `HUBSPOT_DEAL_PIPELINE` (="default"), `HUBSPOT_DEAL_STAGE` (="qualifiedtobuy"). Real IDs for this account: pipeline `default` ("Sales Pipeline"); stages appointmentscheduled, qualifiedtobuy, presentationscheduled, decisionmakerboughtin, contractsent, closedwon, closedlost.

---

## 7. Gotchas learned the hard way (READ THIS)

- **HubSpot search is eventually consistent (lags ~seconds after create).** For find-or-create, use SEARCH + a short RETRY-WITH-BACKOFF loop (3 tries, 1.5s apart), NOT the `idProperty` direct lookup — that lookup returned 200-with-results sometimes and 404 other times for the SAME record (flaky). Both `findOrCreateCompany` and `findOrCreateContact` use the search+retry pattern. Reuse it for any new find-or-create.
- **The single-item sync WIPE bug (fixed, don't reintroduce).** Original bug: the rebuild read part config facts from the current sync BATCH only. Syncing one product rebuilt the parent using only that one product's facts → wiped all other groups/options/rules. FIX: config facts are PERSISTED on product rows (Phase 1), and the rebuild (Phases 3–5) reads them from the DB (`part.configGroup`, `part.configExcludes`, etc.), NOT from the batch. If you touch `applySync`, keep the rebuild reading from the persisted `parts` rows.
- **HubSpot Record ID != Convex `_id`.** Record ID is the HubSpot number; Convex `_id` is the `jd7…`/`jn7…` string. The `products` table bridges them via `hubspotProductId`. Anywhere the code takes `v.id("products")` it wants the Convex `_id`; anywhere it talks to HubSpot it wants the Record ID. When testing actions manually, pass Convex `_id`s, not HubSpot IDs.
- **HubSpot import must be set to UPDATE, matched on Record ID.** A CSV re-import that isn't explicitly matched on Record ID CREATES DUPLICATES. Also: the import wizard defaulted the Record ID column to match on SKU (`hs_sku`) — you must explicitly map it to Record ID / set Record ID as the match key.
- **Line items are product-associated via `hs_product_id`** with a custom `name` override. Price is NOT set (pulled from the product).
- **Line item naming**: `{option} - {parent}`, and append ` - {tag}` ONLY when that parent product appears 2+ times in the cart (the per-build tag disambiguates duplicate builds).
- **Windows/PowerShell**: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` was needed for npm scripts. Files go in `convex/` NOT `.convex/`.
- **Paste hazard**: long-file pastes into the editor repeatedly dropped `<` after generics (`Record<`, `new Map<`) and doubled/mangled closing braces. After a big paste, run: `Select-String -Path convex\hubspot.ts -Pattern "Record$|new Map$|Map$"` to catch dropped brackets.
- **HubSpot v4 association PUT REPLACES labels on a record pair.** `PUT /crm/v4/objects/{from}/{id}/associations/{to}/{id}` with a body of association types OVERWRITES the existing set — to keep a label, include it in the same call. So all labels for a pair go in ONE PUT (why `finalizeCart` gathers a contact's roles before associating). Also: deleting the default unlabeled association removes ALL associations for that pair.
- **This repo's `node_modules` was installed on Windows**, so the `.bin` shims exec `node.exe` and fail in a Linux/CI shell. Run the JS entrypoints directly instead: `node node_modules/typescript/bin/tsc6 -p convex` (and `-p src`) to typecheck; `node node_modules/convex/bin/main.js …` for the Convex CLI.
- **`convex codegen` needs network to the deployment.** Offline is usually fine: `_generated/api.d.ts` uses `ApiFromModules<typeof import(...)>`, so NEW functions in an EXISTING module file are picked up by `tsc` WITHOUT regenerating. Codegen is only required when you add a NEW file under `convex/`.
- **Latent type error fixed**: `src/App.tsx` `toggle()` had `groupOptionIds.includes(x as string)` where the array is `Id<"options">[]`; the bad cast broke `tsc -p src`. Cast removed. `vite`/`convex dev` never typecheck `src/`, so it stayed hidden — run `npm run typecheck` to catch these.
- **`requires` vs `requires_one_of`**: `config_requires` only marks its target `required` (a highlight) — it never blocks submit. For a true "must pick one of these" constraint that blocks Finalize, use `config_requires_one_of` (engine `requiresOneOf` → violation when unmet). `applySync` builds these in PHASE 6 (one rule per part, with a `thenOptionIds` array). The engine already supported `requiresOneOf`; only the authoring path was added. `impliesValue` exists in the engine but is still NOT authorable (no property/phase).

---

## 8. Key files

- `convex/schema.ts` — the four tables + indexes + persisted config facts on products.
- `convex/lib/configEngine.ts` — PURE constraint engine (`evaluate`). Bidirectional excludes. No DB access.
- `convex/lib/configEngine.test.ts` — run with `npx tsx convex/lib/configEngine.test.ts`.
- `convex/hubspot.ts` — sync (`syncProducts` + `applySync`; applySync phases: 1 upsert, 2 attach parts, 3 rebuild groups/options, 4 excludes, 5 requires, 6 requiresOneOf), all write-back functions (findOrCreateCompany, findOrCreateContact, createDeal, addLineItemsToDeal), the `finalizeCart` orchestrator, the `ASSOC` association-type map, and `debugPipelines`.
- `convex/configurator.ts` — `getProductStructure`, `evaluateConfiguration` (runs the engine, returns statuses/prices/total/basePrice/validity flags), `resolveLineItems`, `resolveParentProduct`.
- `convex/products.ts` — `list`, `add`, `listConfigurable` (parents only, indexed).
- `convex/seed.ts` — legacy hand-seed helpers (superseded by HubSpot sync; may still exist).
- `src/App.tsx` — the wizard: App controller (step + customer + cart state + finalize state), ProductPicker (Finalize button + result panel + double-submit guard), Configurator. Cart = array of `{tag, productId, productName, selectedOptionIds, lineItems, total}`.
- `src/CustomerForm.tsx` — customer info step. `CustomerData = {company?, primary, shipping?, billing?}`. Shipping/Billing each have a SOURCE selector: none / same as primary / same as the other section / manual (ship↔bill cycle blocked in the UI); resolved to ContactInfo at submit. Company only included when domain present. PII in React state only.
- `src/main.tsx` — React entry, ConvexProvider, imports `index.css`.
- `src/index.css` — theme tokens (light/dark CSS vars).

---

## 9. How to run

From `~/projects/cpq-configurator` (PowerShell):

- Backend dev loop: `npm run dev` (runs `convex dev`; leave running; opens dashboard).
- Frontend: `npx vite` (second terminal) → localhost:5173.
- Engine tests: `npx tsx convex/lib/configEngine.test.ts`.
- Run a backend function manually: Convex dashboard → Functions → pick → run with args (Convex `_id`s, not HubSpot IDs).
- Sync: set product(s) to `configurator_sync_status = "1"` in HubSpot, run `hubspot:syncProducts`. Single-item sync is now safe.
- Set env: `npx convex env set HUBSPOT_TOKEN "…"` (also HUBSPOT_DEAL_PIPELINE, HUBSPOT_DEAL_STAGE).

---

## 10. Status of the original §10 plan (all DONE)

1. ✅ **Finalize wired** to the chain via the `finalizeCart` orchestrator (one browser call). See §12.
2. ✅ **Double-click guard** — button disables while sending and after success; result panel added.
3. ✅ **Sub-layer 4** — shipping/billing find-or-create + labeled associations, plus "same as primary / same as each other" on the form.
4. ✅ **Error model** — deal + line items CORE; company/contacts/associations best-effort (`warnings`).

Remaining (verification, not code work):

- **Live-test the ship/bill DEAL-association direction** (§6). Wrong direction only logs a warning.
- **Push to `fine-greyhound-640`** (`convex dev`/deploy) so `finalizeCart` exists server-side.
- ~~Require an email for a MANUAL ship/bill section~~ ✅ done — Continue is disabled until a manually-keyed ship/bill contact has a valid email.

---

## 11. Design decisions locked (context for future changes)

- Cart model: ONE deal, MANY configs (Option B). Same product twice = two cart entries (each tagged), NOT a quantity field.
- Parent line item: added ONLY if parent price > 0 (a $0 parent adds nothing and would be noise; deal amount still matches configurator total either way).
- Excludes are bidirectional (compatibility is symmetric). Requires are one-way and advisory (highlight, not submit-blocking) — hardening to submit-blocking is a possible future change.
- Multi-tenant/distribution is a FUTURE goal → would need OAuth + HubSpot projects/CLI (public app). Current build is single-tenant on a Service Key. Auth is isolated so it can be swapped later.
- No HubSpot custom objects available on this tier → rules live as product properties, not a custom Rule object.
- **Contact roles collapse by email.** Ship-to/bill-to can be "same as primary" or "same as each other" (customer form). `finalizeCart` dedupes by email and applies all of a person's labels in one association PUT, so the same email is never created twice and labels never clobber.
- **Deal amount is set explicitly, not rolled up** (see §3). `createDeal` seeds it; `finalizeCart` corrects it to the summed HubSpot line-item amounts.

---

## 12. Finalize orchestrator (`finalizeCart` in `convex/hubspot.ts`)

One public action; the browser calls it once. Args: `{ customer?, configs, cartTotal, dealName?, dealId? }` where `customer = {company?, primary, shipping?, billing?}` (all PII, args-only) and `configs = [{tag, productId, optionIds}]`.

**Two modes** (§13): CREATE (no `dealId`) runs the full chain below; UPDATE (`dealId` set) skips company/deal-create/contacts and only appends line items + re-totals. `customer` is optional and required only in CREATE mode.

Sequence:

1. **Company** (best-effort) — only if `customer.company.domain` present → `companyId`.
2. **Deal** (CORE) — `createDeal` with `amount = cartTotal` seed + company association. Fail → `error`, early return.
3. **Line items** (CORE) — `addLineItemsToDeal` → `lineItemIds`. Fail → `error` (deal already exists; `dealId` returned).
4. **Re-total** — `sumDealLineItems(dealId)` reads EVERY line item associated to the deal (existing + appended), sums their HubSpot `amount`, and PATCHes the deal. On the UPDATE path it never patches when the read fails, so a hiccup can't wipe the prior total. CREATE-path fallback = cart total (the deal was seeded at create).
5. **Contacts** (best-effort, CREATE MODE ONLY) — dedupe primary/shipping/billing by email; for each unique contact call `findOrCreateContact` once with the combined `companyAssociations[]` + `dealAssociations[]`. Primary label = HUBSPOT_DEFINED 1; ship_to/bill_to = USER_DEFINED (§6). Skipped on the UPDATE path (the existing deal owns its contacts).

Returns `{ ok, dealId, companyId, primaryContactId, lineItemsCreated, lineItemsSkipped, amountSet, warnings[], error }`. UI (`src/App.tsx` ProductPicker) renders success/error + warnings and guards double-submit.

Typecheck (Windows node_modules → use JS entrypoints, §7):
`node node_modules/typescript/bin/tsc6 -p convex && node node_modules/typescript/bin/tsc6 -p src`

---

## 13. Deal-first / update path (append to an existing deal)

Two ways to run the tool:

- **Create (default):** rep fills the customer form → picker → configure → Finalize creates a NEW deal (chain in §12).
- **Update (deal-first):** the tool is opened with `?dealId=123` in the URL. `src/App.tsx` reads it, **skips the customer step** (starts in the picker), shows an "Adding to Deal #123" banner, and passes `dealId` to `finalizeCart`. On Finalize it **appends** line items to that deal and **recomputes the deal amount as the sum of ALL its line items** (existing + new). Existing lines are never modified; company/contacts are left as the deal already has them.

**Rules of the update path (locked):**

- Line items are APPEND-only. Running twice appends again (no dedupe) — the UI double-submit guard covers a single session; there is no cross-session guard.
- Amount = sum of every line item on the deal, via `sumDealLineItems` (`GET /crm/v4/objects/deals/{id}/associations/line_items` → batch-read `amount`). If that read fails on the update path, the amount is left unchanged (never zeroed).
- Deal stage/pipeline, company, and existing contacts are untouched.

**HubSpot setup (one-time):** add a way to launch the configurator from a deal with the record ID in the URL — a **CRM card (iframe)** or a **custom action / link** that opens `https://<configurator-host>/?dealId={{deal.hs_object_id}}`. That's the only HubSpot-side work; the code handles the rest.

**Merge-after (rejected):** HubSpot deal merge is lossy/manual and pollutes the pipeline with duplicates until cleaned — kept only as a manual fallback for accidental dupes, never the designed flow.
