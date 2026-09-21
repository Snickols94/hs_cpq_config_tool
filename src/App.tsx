import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";
import { evaluate, Rule } from "../convex/lib/configEngine";
import CustomerForm, { CustomerData } from "./CustomerForm";

// A completed configuration, captured as a self-contained snapshot for the cart.
// `tag` is a short unique id minted when the build is added — used to tell
// duplicate builds apart and to disambiguate line-item names in HubSpot.
type CartConfig = {
  tag: string;
  productId: Id<"products">;
  productName: string;
  selectedOptionIds: Id<"options">[];
  lineItems: { name: string; price: number }[];
  total: number;
};

type Step = "customer" | "picker" | "configure";

// Result of the finalize (HubSpot write-back) orchestrator — mirrors the
// FinalizeResult returned by convex/hubspot.ts:finalizeCart.
type FinalizeOutcome = {
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

// Short unique tag for a cart build (client-side, no HubSpot dependency).
function makeTag(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function App() {
  const [dark, setDark] = useState(false);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

  // Optional deal-first launch: /?dealId=123 opens straight into the picker and
  // APPENDS to that existing HubSpot deal instead of creating a new one.
  const [dealId] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get("dealId");
    } catch {
      return null;
    }
  });

  // Wizard state — all transient. PII lives in `customer` (React state only).
  const [step, setStep] = useState<Step>(dealId ? "picker" : "customer");
  const [customer, setCustomer] = useState<CustomerData | null>(null);
  const [activeProduct, setActiveProduct] = useState<Id<"products"> | null>(
    null,
  );
  const [cart, setCart] = useState<CartConfig[]>([]);

  // Finalize (HubSpot write-back) state.
  const runFinalize = useAction(api.hubspot.finalizeCart);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeResult, setFinalizeResult] = useState<FinalizeOutcome | null>(
    null,
  );

  const handleFinalize = async () => {
    // Double-submit guard. Create mode needs a customer; update mode (dealId in
    // the URL) appends to the existing deal and needs no customer form.
    if (finalizing || cart.length === 0) return;
    if (!dealId && !customer) return;
    if (finalizeResult?.ok) return;
    setFinalizing(true);
    setFinalizeResult(null);
    try {
      const res = await runFinalize({
        customer: customer ?? undefined,
        dealId: dealId ?? undefined,
        authToken: import.meta.env.VITE_FINALIZE_SECRET as string | undefined,
        configs: cart.map((c) => ({
          tag: c.tag,
          productId: c.productId,
          optionIds: c.selectedOptionIds,
        })),
        cartTotal: cart.reduce((sum, c) => sum + c.total, 0),
      });
      setFinalizeResult(res);
    } catch (e) {
      setFinalizeResult({
        ok: false,
        dealId: null,
        companyId: null,
        primaryContactId: null,
        lineItemsCreated: 0,
        lineItemsSkipped: 0,
        amountSet: null,
        warnings: [],
        error: String(e),
      });
    } finally {
      setFinalizing(false);
    }
  };

  // After a successful send, reset for the next one. In deal-first mode this
  // returns to the picker (so more items append to the SAME deal); in create
  // mode it returns to the customer step (the next send makes a NEW deal).
  const startNew = () => {
    setFinalizeResult(null);
    setCart([]);
    setActiveProduct(null);
    setStep(dealId ? "picker" : "customer");
  };

  const themeToggle = (
    <button
      onClick={() => setDark((d) => !d)}
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        padding: "8px 14px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        color: "var(--text)",
        cursor: "pointer",
      }}
    >
      {dark ? "☀ Light" : "🌙 Dark"}
    </button>
  );

  const addToCart = (config: Omit<CartConfig, "tag">) => {
    setCart((prev) => [...prev, { ...config, tag: makeTag() }]);
    setActiveProduct(null);
    setStep("picker"); // back to picker; add another or finalize
  };

  const removeFromCart = (tag: string) => {
    setCart((prev) => prev.filter((c) => c.tag !== tag));
  };

  let screen;
  if (finalizeResult?.ok) {
    // Sent successfully: show only the deal confirmation, not a live picker
    // you can't submit from.
    screen = (
      <FinalizedScreen
        result={finalizeResult}
        dealId={dealId}
        onReset={startNew}
      />
    );
  } else if (step === "customer") {
    screen = (
      <CustomerForm
        initial={customer ?? undefined}
        onContinue={(data) => {
          setCustomer(data);
          setStep("picker");
        }}
      />
    );
  } else if (step === "picker") {
    screen = (
      <ProductPicker
        cart={cart}
        dealId={dealId}
        onBackToCustomer={() => setStep("customer")}
        onPick={(id) => {
          setActiveProduct(id);
          setStep("configure");
        }}
        onRemove={removeFromCart}
        onFinalize={handleFinalize}
        finalizing={finalizing}
        finalizeResult={finalizeResult}
      />
    );
  } else if (step === "configure" && activeProduct) {
    screen = (
      <Configurator
        productId={activeProduct}
        onBack={() => {
          setActiveProduct(null);
          setStep("picker");
        }}
        onAddToCart={addToCart}
      />
    );
  }

  return (
    <>
      {themeToggle}
      {screen}
    </>
  );
}

// ---------- Finalized (sent) confirmation ----------
function FinalizedScreen({
  result,
  dealId,
  onReset,
}: {
  result: FinalizeOutcome;
  dealId: string | null;
  onReset: () => void;
}) {
  const row: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 0",
  };
  return (
    <div
      style={{
        fontFamily: "system-ui",
        padding: 32,
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      <h1 style={{ color: "#16a34a" }}>Sent to HubSpot ✓</h1>
      <div
        style={{
          margin: "16px 0",
          padding: 20,
          borderRadius: 12,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
        }}
      >
        <div style={row}>
          <span>Deal ID</span>
          <strong>{result.dealId}</strong>
        </div>
        <div style={row}>
          <span>Line items added</span>
          <strong>{result.lineItemsCreated}</strong>
        </div>
        {result.amountSet != null && (
          <div style={row}>
            <span>Deal amount</span>
            <strong>${result.amountSet}</strong>
          </div>
        )}
        {result.warnings.length > 0 && (
          <ul
            style={{
              margin: "10px 0 0",
              paddingLeft: 18,
              fontSize: 13,
              color: "#b45309",
            }}
          >
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>

      {dealId ? (
        <p style={{ color: "var(--muted)", fontSize: 14 }}>
          You can close this tab and return to the deal in HubSpot.
        </p>
      ) : null}

      <button
        onClick={onReset}
        style={{
          marginTop: 8,
          padding: "12px 24px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          fontSize: 15,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {dealId ? "Add more to this deal" : "Configure another"}
      </button>
    </div>
  );
}

// ---------- Product picker ----------
function ProductPicker({
  cart,
  dealId,
  onPick,
  onBackToCustomer,
  onRemove,
  onFinalize,
  finalizing,
  finalizeResult,
}: {
  cart: CartConfig[];
  dealId: string | null;
  onPick: (id: Id<"products">) => void;
  onBackToCustomer: () => void;
  onRemove: (tag: string) => void;
  onFinalize: () => void;
  finalizing: boolean;
  finalizeResult: FinalizeOutcome | null;
}) {
  const products = useQuery(api.products.listConfigurable);
  if (products === undefined) return <p style={{ padding: 32 }}>Loading…</p>;

  const cartTotal = cart.reduce((sum, c) => sum + c.total, 0);

  // Count how many times each product appears — used to decide whether a
  // build's tag should be shown to disambiguate duplicates.
  const productCounts = cart.reduce<Record<string, number>>((acc, c) => {
    acc[c.productId] = (acc[c.productId] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div
      style={{
        fontFamily: "system-ui",
        padding: 32,
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      {dealId ? (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: 14,
          }}
        >
          Adding to existing HubSpot deal <strong>#{dealId}</strong>. New line
          items are appended and the deal total is recalculated.
        </div>
      ) : (
        <button
          onClick={onBackToCustomer}
          style={{
            marginBottom: 16,
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            cursor: "pointer",
          }}
        >
          ← Back to customer info
        </button>
      )}

      <h1>Choose a Product to Configure</h1>

      <div
        style={{
          display: "flex",
          gap: 32,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {/* Left: product list — the center stays for choosing/configuring. */}
        <div
          style={{
            flex: "1 1 400px",
            minWidth: 300,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {products.map((prod) => (
            <button
              key={prod._id}
              onClick={() => onPick(prod._id)}
              style={{
                padding: "14px 20px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                textAlign: "left",
                fontSize: 16,
                cursor: "pointer",
              }}
            >
              {prod.name}
            </button>
          ))}
        </div>

        {/* Right: cart — mirrors the configurator's running-cost panel. */}
        <div
          style={{
            flex: "0 0 320px",
            position: "sticky",
            top: 32,
            padding: 20,
            borderRadius: 12,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Cart ({cart.length})</h3>

          {cart.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>
              No configurations added yet.
            </p>
          ) : (
            <>
              <div
                style={{
                  margin: "8px 0",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {cart.map((c) => {
                  const isDuplicated = productCounts[c.productId] > 1;
                  return (
                    <div
                      key={c.tag}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span>
                        {c.productName}
                        {isDuplicated ? ` (${c.tag})` : ""} — ${c.total}
                      </span>
                      <button
                        onClick={() => onRemove(c.tag)}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>

              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: "1px solid var(--border)",
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 20,
                  fontWeight: 700,
                }}
              >
                <span>Total</span>
                <span>${cartTotal}</span>
              </div>

              <button
                onClick={onFinalize}
                disabled={finalizing || finalizeResult?.ok === true}
                style={{
                  marginTop: 16,
                  width: "100%",
                  padding: "14px 20px",
                  borderRadius: 8,
                  border: "none",
                  fontSize: 15,
                  fontWeight: 700,
                  cursor:
                    finalizing || finalizeResult?.ok
                      ? "not-allowed"
                      : "pointer",
                  background:
                    finalizing || finalizeResult?.ok
                      ? "var(--border)"
                      : "#FF7A59",
                  color:
                    finalizing || finalizeResult?.ok ? "var(--muted)" : "#fff",
                }}
              >
                {finalizing
                  ? "Sending to HubSpot…"
                  : finalizeResult?.ok
                    ? "Sent ✓"
                    : dealId
                      ? "Add to Deal & Recalculate"
                      : "Finalize & Send to HubSpot"}
              </button>

              {finalizeResult && !finalizeResult.ok && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                  }}
                >
                  <strong style={{ color: "#dc2626" }}>Finalize failed</strong>
                  <div style={{ marginTop: 6, fontSize: 13 }}>
                    {finalizeResult.error}
                    {finalizeResult.dealId
                      ? ` (a deal was created: ${finalizeResult.dealId} — review it in HubSpot)`
                      : ""}
                  </div>
                  {finalizeResult.warnings.length > 0 && (
                    <ul
                      style={{
                        margin: "10px 0 0",
                        paddingLeft: 18,
                        fontSize: 13,
                        color: "#b45309",
                      }}
                    >
                      {finalizeResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Configurator ----------
function Configurator({
  productId,
  onBack,
  onAddToCart,
}: {
  productId: Id<"products">;
  onBack: () => void;
  onAddToCart: (config: Omit<CartConfig, "tag">) => void;
}) {
  const [selected, setSelected] = useState<Id<"options">[]>([]);

  const model = useQuery(api.configurator.getConfiguratorModel, { productId });

  if (!model) return <p style={{ padding: 32 }}>Loading…</p>;

  const productName = model.name;
  const structure = model.groups;

  // Run the PURE constraint engine locally on every selection. Synchronous, so
  // rules enact instantly — a conflicting option becomes disabled the moment
  // its counterpart is chosen (no per-click server round trip, no stale window,
  // no flicker), which is what previously let an incompatible cart slip through.
  const allOptionIds = structure.flatMap((g) => g.options.map((o) => o.id));
  const result = evaluate(
    allOptionIds,
    selected as string[],
    model.rules as Rule[],
  );

  const priceById: Record<string, number> = {};
  const nameById: Record<string, string> = {};
  for (const g of structure)
    for (const o of g.options) {
      priceById[o.id] = o.price;
      nameById[o.id] = o.name;
    }

  const optionsTotal = selected.reduce(
    (sum, id) => sum + (priceById[id] ?? 0),
    0,
  );
  const total = model.basePrice + optionsTotal;

  const missingGroups = structure
    .filter((g) => g.required)
    .filter(
      (g) => !g.options.some((o) => selected.includes(o.id as Id<"options">)),
    )
    .map((g) => g.name);

  // Engine violation strings reference option IDs; swap in names for display.
  const violations = result.violations.map((msg) => {
    let out = msg;
    for (const [id, name] of Object.entries(nameById))
      out = out.split(id).join(name);
    return out;
  });

  const canSubmit = missingGroups.length === 0 && violations.length === 0;

  const evaluation = {
    basePrice: model.basePrice,
    total,
    missingGroups,
    violations,
    canSubmit,
    options: structure.flatMap((g) =>
      g.options.map((o) => ({
        id: o.id,
        name: o.name,
        groupId: g.id,
        price: o.price,
        status: result.statuses[o.id] ?? "available",
      })),
    ),
  };

  const statusOf = (id: string) =>
    evaluation.options.find((o) => o.id === id)?.status ?? "available";
  const priceOf = (id: string) => priceById[id] ?? 0;

  const toggle = (id: Id<"options">) => {
    if (statusOf(id) === "disabled") return;

    // Find which group this option belongs to, and whether that group is single-select.
    const group = structure.find((g) => g.options.some((o) => o.id === id));
    const isSingle = group?.selectionType === "single";

    setSelected((prev) => {
      const alreadySelected = prev.includes(id);

      if (alreadySelected) {
        // Clicking a selected option deselects it (both single and multi).
        return prev.filter((x) => x !== id);
      }

      if (isSingle && group) {
        // Single-select: remove any other selection from THIS group, then add.
        const groupOptionIds = group.options.map((o) => o.id);
        const withoutGroup = prev.filter(
          (x) => !groupOptionIds.includes(x),
        );
        return [...withoutGroup, id];
      }

      // Multi-select (Add-ons): just add.
      return [...prev, id];
    });
  };

  const handleAdd = () => {
    const lineItems = evaluation.options
      .filter((o) => selected.includes(o.id as Id<"options">))
      .map((o) => ({ name: o.name, price: o.price }));
    onAddToCart({
      productId,
      productName,
      selectedOptionIds: selected,
      lineItems,
      total: evaluation.total,
    });
  };

  return (
    <div
      style={{
        fontFamily: "system-ui",
        padding: 32,
        maxWidth: 1100,
        margin: "0 auto",
      }}
    >
      <button
        onClick={onBack}
        style={{
          marginBottom: 16,
          padding: "6px 12px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          cursor: "pointer",
        }}
      >
        ← Back to products
      </button>

      <h1>Configure: {productName}</h1>

      <div
        style={{
          display: "flex",
          gap: 32,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div style={{ flex: "1 1 400px", minWidth: 300 }}>
          {structure.map((group) => {
            // If any option in this group is rule-required, narrow the group
            // to ONLY its required options (grey out the non-required rest).
            // A single-select group is "locked" once it has a required option
            // OR a selected one — so the non-chosen siblings stay greyed even
            // after the required option is picked (status flips required→selected).
            const groupHasSelection = group.options.some(
              (o) => statusOf(o.id) === "selected",
            );
            const groupHasRequired = group.options.some(
              (o) => statusOf(o.id) === "required",
            );
            const narrowGroup =
              group.selectionType === "single" &&
              (groupHasRequired || groupHasSelection);
            return (
              <div key={group.id} style={{ marginBottom: 24 }}>
                <h3>{group.name}</h3>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {group.options.map((opt) => {
                    const status = statusOf(opt.id);
                    const isSelected = selected.includes(
                      opt.id as Id<"options">,
                    );
                    const required = status === "required";
                    const disabled =
                      status === "disabled" ||
                      (narrowGroup && !required && !isSelected);
                    return (
                      <button
                        key={opt.id}
                        onClick={() => toggle(opt.id as Id<"options">)}
                        disabled={disabled}
                        style={{
                          padding: "10px 16px",
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          cursor: disabled ? "not-allowed" : "pointer",
                          background: isSelected
                            ? "var(--selected)"
                            : required
                              ? "var(--required-bg)"
                              : "var(--surface)",
                          color: isSelected
                            ? "#fff"
                            : disabled
                              ? "var(--muted)"
                              : "var(--text)",
                          opacity: disabled ? 0.5 : 1,
                        }}
                      >
                        {opt.name}
                        {priceOf(opt.id) > 0 ? ` — $${priceOf(opt.id)}` : ""}
                        {required && !isSelected ? " (required)" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            flex: "0 0 300px",
            position: "sticky",
            top: 32,
            padding: 20,
            borderRadius: 12,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            color: "var(--text)",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Running Cost</h3>

          {evaluation.basePrice > 0 && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                paddingBottom: 8,
              }}
            >
              <span>Base price</span>
              <span>${evaluation.basePrice}</span>
            </div>
          )}

          {selected.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No options selected yet.</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {evaluation.options
                  .filter((o) => selected.includes(o.id as Id<"options">))
                  .map((o) => (
                    <tr key={o.id}>
                      <td style={{ padding: "4px 0" }}>{o.name}</td>
                      <td style={{ padding: "4px 0", textAlign: "right" }}>
                        ${o.price}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}

          <div
            style={{
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--border)",
              display: "flex",
              justifyContent: "space-between",
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            <span>Total</span>
            <span>${evaluation.total}</span>
          </div>

          {evaluation.missingGroups.length > 0 && (
            <p style={{ color: "#f59e0b", marginTop: 16, fontSize: 14 }}>
              Still needed: {evaluation.missingGroups.join(", ")}
            </p>
          )}

          {evaluation.violations.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p
                style={{
                  color: "#dc2626",
                  fontSize: 14,
                  margin: 0,
                  fontWeight: 700,
                }}
              >
                Can't combine:
              </p>
              <ul
                style={{
                  margin: "4px 0 0",
                  paddingLeft: 18,
                  fontSize: 13,
                  color: "#dc2626",
                }}
              >
                {evaluation.violations.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </div>
          )}

          <button
            disabled={!evaluation.canSubmit}
            onClick={handleAdd}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "14px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 15,
              fontWeight: 700,
              cursor: evaluation.canSubmit ? "pointer" : "not-allowed",
              background: evaluation.canSubmit ? "#2563eb" : "var(--border)",
              color: evaluation.canSubmit ? "#fff" : "var(--muted)",
            }}
          >
            {evaluation.canSubmit
              ? "Add to Cart"
              : evaluation.violations.length > 0
                ? "Resolve conflicts to continue"
                : "Complete configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}
