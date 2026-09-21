import { useState } from "react";

// The shape of customer data the wizard collects. All transient (React state
// only) — never persisted to Convex.
export type ContactInfo = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zip: string;
};

export type CompanyInfo = {
  name: string;
  domain: string;
};

export type CustomerData = {
  company?: CompanyInfo; // only included when a domain is provided
  primary: ContactInfo;
  shipping?: ContactInfo;
  billing?: ContactInfo;
};

const emptyContact = (): ContactInfo => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  street: "",
  city: "",
  state: "",
  zip: "",
});

// Basic email format check.
const emailValid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const field: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  marginBottom: 8,
  boxSizing: "border-box",
};

// How a shipping/billing contact is sourced:
//   none    — not needed
//   primary — the same person as the primary contact
//   other   — the same person as the *other* section (ship<->bill)
//   manual  — entered separately below
type Source = "none" | "primary" | "other" | "manual";

function ContactFields({
  value,
  onChange,
  emailRequired = false,
}: {
  value: ContactInfo;
  onChange: (c: ContactInfo) => void;
  emailRequired?: boolean;
}) {
  const set = (k: keyof ContactInfo, v: string) =>
    onChange({ ...value, [k]: v });

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={field}
          placeholder="First name"
          value={value.firstName}
          onChange={(e) => set("firstName", e.target.value)}
        />
        <input
          style={field}
          placeholder="Last name"
          value={value.lastName}
          onChange={(e) => set("lastName", e.target.value)}
        />
      </div>
      <input
        style={field}
        placeholder={emailRequired ? "Email (required)" : "Email"}
        value={value.email}
        onChange={(e) => set("email", e.target.value)}
      />
      <input
        style={field}
        placeholder="Phone"
        value={value.phone}
        onChange={(e) => set("phone", e.target.value)}
      />
      <input
        style={field}
        placeholder="Street"
        value={value.street}
        onChange={(e) => set("street", e.target.value)}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <input
          style={field}
          placeholder="City"
          value={value.city}
          onChange={(e) => set("city", e.target.value)}
        />
        <input
          style={{ ...field, maxWidth: 80 }}
          placeholder="State"
          value={value.state}
          onChange={(e) => set("state", e.target.value)}
        />
        <input
          style={{ ...field, maxWidth: 120 }}
          placeholder="ZIP"
          value={value.zip}
          onChange={(e) => set("zip", e.target.value)}
        />
      </div>
    </div>
  );
}

// A shipping or billing section: a source dropdown plus, when "manual", the
// contact fields. "Same as {otherLabel}" is disabled when the other section
// already points back here (prevents a ship<->bill cycle).
function ContactSection({
  title,
  otherLabel,
  source,
  onSource,
  disableOther,
  otherIsNone,
  manual,
  onManual,
  manualEmailInvalid,
}: {
  title: string;
  otherLabel: string;
  source: Source;
  onSource: (s: Source) => void;
  disableOther: boolean;
  otherIsNone: boolean;
  manual: ContactInfo;
  onManual: (c: ContactInfo) => void;
  manualEmailInvalid: boolean;
}) {
  return (
    <div style={{ margin: "20px 0 8px" }}>
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      <select
        value={source}
        onChange={(e) => onSource(e.target.value as Source)}
        style={field}
      >
        <option value="none">Not needed</option>
        <option value="primary">Same as primary contact</option>
        <option value="other" disabled={disableOther}>
          Same as {otherLabel} contact
        </option>
        <option value="manual">Enter separately</option>
      </select>

      {source === "manual" && (
        <>
          <ContactFields value={manual} onChange={onManual} emailRequired />
          {manualEmailInvalid && (
            <p style={{ color: "#dc2626", fontSize: 13, marginTop: 0 }}>
              Enter a valid email address (required to create this contact).
            </p>
          )}
        </>
      )}
      {source === "other" && otherIsNone && (
        <p style={{ color: "#b45309", fontSize: 13, marginTop: 0 }}>
          The {otherLabel} section is set to "Not needed", so there's nothing to
          copy yet.
        </p>
      )}
    </div>
  );
}

// Infer an initial source when re-entering the form: if a saved section shares
// the primary's email it was "same as primary", otherwise treat it as manual.
const inferSource = (
  section: ContactInfo | undefined,
  primaryEmail: string,
): Source => {
  if (!section) return "none";
  if (
    section.email &&
    section.email.trim().toLowerCase() === primaryEmail.trim().toLowerCase()
  ) {
    return "primary";
  }
  return "manual";
};

export default function CustomerForm({
  initial,
  onContinue,
}: {
  initial?: CustomerData;
  onContinue: (data: CustomerData) => void;
}) {
  const [companyName, setCompanyName] = useState(initial?.company?.name ?? "");
  const [companyDomain, setCompanyDomain] = useState(
    initial?.company?.domain ?? "",
  );
  const [primary, setPrimary] = useState<ContactInfo>(
    initial?.primary ?? emptyContact(),
  );

  const initialPrimaryEmail = initial?.primary?.email ?? "";
  const [shippingSource, setShippingSource] = useState<Source>(
    inferSource(initial?.shipping, initialPrimaryEmail),
  );
  const [shipping, setShipping] = useState<ContactInfo>(
    initial?.shipping ?? emptyContact(),
  );
  const [billingSource, setBillingSource] = useState<Source>(
    inferSource(initial?.billing, initialPrimaryEmail),
  );
  const [billing, setBilling] = useState<ContactInfo>(
    initial?.billing ?? emptyContact(),
  );

  const primaryEmail = primary.email.trim();
  // A manually-keyed shipping/billing contact must have a valid email (it is
  // the find-or-create key); "same as" sources inherit the primary's email.
  const shippingEmailMissing =
    shippingSource === "manual" && !emailValid(shipping.email.trim());
  const billingEmailMissing =
    billingSource === "manual" && !emailValid(billing.email.trim());
  const canContinue =
    emailValid(primaryEmail) && !shippingEmailMissing && !billingEmailMissing;
  // Show the inline error only once the user has typed something invalid
  // (empty is communicated by the required placeholder + disabled button).
  const shippingEmailInvalid =
    shippingSource === "manual" &&
    shipping.email.trim().length > 0 &&
    !emailValid(shipping.email.trim());
  const billingEmailInvalid =
    billingSource === "manual" &&
    billing.email.trim().length > 0 &&
    !emailValid(billing.email.trim());

  // Resolve a section's source into the actual contact (one hop; the UI blocks
  // a ship<->bill cycle so this always terminates).
  const primaryResolved = (): ContactInfo => ({ ...primary, email: primaryEmail });
  const resolve = (
    source: Source,
    manual: ContactInfo,
    otherSource: Source,
    otherManual: ContactInfo,
  ): ContactInfo | undefined => {
    switch (source) {
      case "none":
        return undefined;
      case "primary":
        return primaryResolved();
      case "manual":
        return manual;
      case "other":
        // Reference the other section, resolved once.
        if (otherSource === "primary") return primaryResolved();
        if (otherSource === "manual") return otherManual;
        return undefined; // other is "none" or (blocked) "other"
    }
  };

  const submit = () => {
    if (!canContinue) return;
    const domain = companyDomain.trim();
    onContinue({
      // Company only included when a domain is given — domain is the dedupe key.
      company: domain ? { name: companyName.trim(), domain } : undefined,
      primary: primaryResolved(),
      shipping: resolve(shippingSource, shipping, billingSource, billing),
      billing: resolve(billingSource, billing, shippingSource, shipping),
    });
  };

  return (
    <div
      style={{
        fontFamily: "system-ui",
        padding: 32,
        maxWidth: 640,
        margin: "0 auto",
      }}
    >
      <h1>Customer Information</h1>

      <h3>Company (optional)</h3>
      <input
        style={field}
        placeholder="Company name"
        value={companyName}
        onChange={(e) => setCompanyName(e.target.value)}
      />
      <input
        style={field}
        placeholder="Company domain (e.g. acme.com)"
        value={companyDomain}
        onChange={(e) => setCompanyDomain(e.target.value)}
      />
      {companyName.trim().length > 0 && companyDomain.trim().length === 0 && (
        <p style={{ color: "#b45309", fontSize: 13, marginTop: 0 }}>
          A company won't be created without a domain. Add a domain to create
          the company record.
        </p>
      )}

      <h3>Primary Contact</h3>
      <ContactFields value={primary} onChange={setPrimary} emailRequired />
      {!canContinue && primaryEmail.length > 0 && (
        <p style={{ color: "#dc2626", fontSize: 13, marginTop: 0 }}>
          Enter a valid email address.
        </p>
      )}

      <ContactSection
        title="Shipping Contact"
        otherLabel="billing"
        source={shippingSource}
        onSource={setShippingSource}
        disableOther={billingSource === "other"}
        otherIsNone={billingSource === "none"}
        manual={shipping}
        onManual={setShipping}
        manualEmailInvalid={shippingEmailInvalid}
      />

      <ContactSection
        title="Billing Contact"
        otherLabel="shipping"
        source={billingSource}
        onSource={setBillingSource}
        disableOther={shippingSource === "other"}
        otherIsNone={shippingSource === "none"}
        manual={billing}
        onManual={setBilling}
        manualEmailInvalid={billingEmailInvalid}
      />

      <button
        onClick={submit}
        disabled={!canContinue}
        style={{
          marginTop: 24,
          padding: "14px 28px",
          borderRadius: 8,
          border: "none",
          fontSize: 16,
          fontWeight: 700,
          cursor: canContinue ? "pointer" : "not-allowed",
          background: canContinue ? "#2563eb" : "var(--border)",
          color: canContinue ? "#fff" : "var(--muted)",
        }}
      >
        {canContinue
          ? "Continue to products"
          : "Enter a valid email to continue"}
      </button>
    </div>
  );
}
