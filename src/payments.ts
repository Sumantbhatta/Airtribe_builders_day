import crypto from "node:crypto";
import { q, one, logEvent } from "./db.js";
import type { Learner } from "./store.js";

// Pine Labs Online hosted checkout (UAT by default). Endpoints per
// pinelabs.com/docs/online-payments/third-party-validations/integration-steps-hosted
// and /payment-lifecycle/orders. We never trust the browser redirect alone:
// every status change is confirmed server-side with Get Order.

const BASE = () => (process.env.PINELABS_BASE_URL || "https://pluraluat.v2.pinepg.in").replace(/\/$/, "");
export const paymentsEnabled = () => !!(process.env.PINELABS_CLIENT_ID && process.env.PINELABS_CLIENT_SECRET);

export const PRODUCTS = {
  mentor_review: { name: "Human mentor review", amountPaise: 4900 },
} as const;

let cachedToken: { value: string; exp: number } | null = null;

function headers(extra: Record<string, string> = {}) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "Request-ID": crypto.randomUUID(),
    "Request-Timestamp": new Date().toISOString(),
    ...extra,
  };
}

async function token(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const r = await fetch(`${BASE()}/api/auth/v1/token`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      client_id: process.env.PINELABS_CLIENT_ID,
      client_secret: process.env.PINELABS_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Pine Labs token failed (${r.status}): ${j.message ?? j.error ?? "no access_token"}`);
  cachedToken = { value: j.access_token, exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: headers({ Authorization: `Bearer ${await token()}` }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const publicBase = () => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");

export async function createCheckout(learner: Learner, product: keyof typeof PRODUCTS): Promise<string> {
  const p = PRODUCTS[product];
  const ref = `cm${learner.id}x${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const row = (await one<{ id: number }>(
    `insert into payments (learner_id, product, amount_paise, status, merchant_order_ref, is_test)
     values ($1,$2,$3,'INITIATED',$4,$5) returning id`,
    [learner.id, product, p.amountPaise, ref, learner.is_test],
  ))!;
  await logEvent("payment.initiated", { payment_id: row.id, product, amount_paise: p.amountPaise, ref }, learner.id);

  const callback = `${publicBase()}/pay/callback?ref=${encodeURIComponent(ref)}`;
  const mobile = (learner.phone ?? "").replace(/^\+91/, "").replace(/\D/g, "");
  const { status, json } = await api("POST", "/api/checkout/v1/orders", {
    merchant_order_reference: ref,
    order_amount: { value: p.amountPaise, currency: "INR" },
    pre_auth: false,
    allowed_payment_methods: ["CARD", "UPI", "NETBANKING", "WALLET"],
    notes: `${p.name} for learner ${learner.id}`,
    callback_url: callback,
    failure_callback_url: callback,
    purchase_details: {
      customer: {
        first_name: learner.name.slice(0, 40),
        customer_id: `learner-${learner.id}`,
        ...(mobile.length === 10 ? { mobile_number: mobile } : {}),
      },
      merchant_metadata: { learner_id: String(learner.id), product },
    },
  });
  const redirect = json.redirect_url;
  await q("update payments set status=$1, provider_order_id=$2, raw = raw || $3::jsonb, updated_at=now() where id=$4", [
    redirect ? "CREATED" : "CREATE_FAILED",
    json.order_id ?? null,
    JSON.stringify({ create_response: { http: status, response_code: json.response_code, response_message: json.response_message, order_id: json.order_id } }),
    row.id,
  ]);
  await logEvent(redirect ? "payment.order_created" : "payment.order_failed", { payment_id: row.id, http: status, order_id: json.order_id, msg: json.response_message ?? json.message }, learner.id);
  if (!redirect) throw Object.assign(new Error("Payment provider did not return a checkout link. Please try again."), { status: 502 });
  return redirect;
}

/**
 * Callback signature per docs: sort the returned fields by key, join as k=v with '&',
 * HMAC-SHA256 with the hex-decoded secret, uppercase hex. The docs are ambiguous on the
 * key encoding, so we try hex-decoded and raw-utf8 and record which (if any) matched.
 */
export function verifyCallbackSignature(params: Record<string, string>, secret: string | undefined): "hex_key" | "utf8_key" | "invalid" | "no_secret" {
  if (!secret || !params.signature) return "no_secret";
  const msg = Object.keys(params)
    .filter((k) => k !== "signature" && k !== "ref" && params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const sig = params.signature.toUpperCase();
  const tryKey = (key: Buffer) => crypto.createHmac("sha256", key).update(msg).digest("hex").toUpperCase();
  if (/^[0-9a-f]+$/i.test(secret) && secret.length % 2 === 0 && tryKey(Buffer.from(secret, "hex")) === sig) return "hex_key";
  if (tryKey(Buffer.from(secret, "utf8")) === sig) return "utf8_key";
  return "invalid";
}

const mapStatus = (s: string | undefined) =>
  s === "PROCESSED" || s === "AUTHORIZED" ? "SUCCESS" : s === "FAILED" || s === "CANCELLED" ? "FAILED" : s ? `PENDING_${s}` : "UNKNOWN";

/** Ask Pine Labs for the authoritative order status and store it. */
export async function syncPayment(ref: string, via: string): Promise<{ status: string; learnerId: number | null } | null> {
  const p = await one<{ id: number; learner_id: number; provider_order_id: string | null; status: string }>(
    "select id, learner_id, provider_order_id, status from payments where merchant_order_ref=$1",
    [ref],
  );
  if (!p) return null;
  const path = p.provider_order_id ? `/api/pay/v1/orders/${encodeURIComponent(p.provider_order_id)}` : `/api/pay/v1/orders/reference/${encodeURIComponent(ref)}`;
  const { status: http, json } = await api("GET", path);
  const d = json.data ?? {};
  const status = http === 200 ? mapStatus(d.status) : p.status;
  const paymentId = Array.isArray(d.payments) && d.payments[0]?.id ? String(d.payments[0].id) : null;
  await q(
    "update payments set status=$1, provider_payment_id=coalesce($2, provider_payment_id), raw = raw || $3::jsonb, updated_at=now() where id=$4",
    [status, paymentId, JSON.stringify({ last_sync: { via, http, provider_status: d.status ?? null, at: new Date().toISOString() } }), p.id],
  );
  if (status !== p.status) {
    await logEvent(`payment.${status === "SUCCESS" ? "success" : status === "FAILED" ? "failed" : "status"}`, { payment_id: p.id, provider_status: d.status, via }, p.learner_id);
  }
  return { status, learnerId: p.learner_id };
}
