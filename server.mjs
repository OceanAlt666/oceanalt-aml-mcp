#!/usr/bin/env node
// OceanAlt AML — MCP server. Lets Claude / Cursor / any MCP client natively call
// OceanAlt's on-chain address screening + compliance gateway. Ask "is this payee safe?"
// BEFORE money moves — verdicts ship with clickable, verifiable evidence, not a black-box score.
//
// Free tools (screen / decide / payee decision / control baseline / agent identity / recent flagged /
// intent check incl. Solana / signed-402 verification / evidence bundle — no key, no signup) and three optional
// x402 pay-per-call tools (gateway decision / deep taint trace / batch). The paid tools lazy-load
// @x402 + viem and only activate when a payer wallet key (OCEANALT_PAYER_KEY) is set; if unset or
// deps are missing they return a clear message and never crash. The facilitator verifies + settles
// and pays gas — it never custodies your funds.
//
// This package is a thin (~9KB) client for OceanAlt's PUBLIC API: no proprietary logic, no data,
// no keys, no scoring or lists on board — the AML engine runs server-side at oceanalt.com.
//
// MCP client config (Claude Desktop / Claude Code / Cursor …):
//   { "mcpServers": { "oceanalt-aml": { "command": "npx", "args": ["-y", "oceanalt-aml-mcp"],
//       "env": { "OCEANALT_PAYER_KEY": "0x… (optional, enables paid tools)" } } } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

const BASE = (process.env.OCEANALT_BASE || "https://oceanalt.com").replace(/\/$/, "");
const TIMEOUT = 15000;
// Supported EVM chains — kept in lockstep with the site's lib/aml.ts EVM_NETS (only chains proven live).
const NETWORKS = ["ethereum", "base", "bsc", "polygon", "arbitrum", "optimism", "avalanche"];

async function apiPost(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(BASE + path, { method: "POST", signal: ctrl.signal, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok && res.status >= 500) throw new Error(`OceanAlt ${path} → HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function apiGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`OceanAlt ${path} → HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// 版本号从 package.json 读,不写死。
// 2026-09-08:这里曾经写死 "0.4.0",而启动日志写死 "v0.3",package.json 又是第三个数 ——
// 三处各说各话,发布时还漏过一次版本号(commit 52f351c)。单一事实源之后不会再漂。
// npm 打包永远会带上 package.json,所以正常情况读得到;万一读不到也不能让 server 起不来。
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version; }
  catch { return "0.0.0-unknown"; }
})();
const server = new McpServer({ name: "oceanalt-aml", version: PKG_VERSION });

server.registerTool(
  "screen_address",
  {
    title: "Screen a blockchain address for AML risk (free)",
    description:
      "Run an AML compliance screen on a single blockchain address BEFORE paying or receiving from it — the answer to \"is this counterparty safe?\". Checks OFAC sanctions, known mixers, community scam/phishing lists, stablecoin issuer freezes (USDT/USDC), and on-chain heuristics (address age, activity, one-hop taint from flagged addresses). Returns a verdict (clear | caution | risky), a 0–100 risk score, a blocked flag, and clickable verifiable evidence showing which list/label/on-chain path matched — receipts, not a black-box score. Supports EVM (0x…), Tron (T…), and Solana (base58). Free, no API key, no signup.",
    inputSchema: {
      address: z
        .string()
        .describe("Address to screen. EVM: 0x + 40 hex (e.g. 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045). Tron: T + 33 base58 (e.g. TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t). Solana: base58 public key."),
      network: z
        .enum(NETWORKS)
        .optional()
        .describe("EVM chain to screen on. Omit to auto-default to ethereum; ignored for Tron/Solana (auto-detected). One of: ethereum, base, bsc, polygon, arbitrum, optimism, avalanche."),
      lang: z.enum(["en", "zh"]).optional().describe("Language for human-readable fields (signals, note). Defaults to English."),
    },
    annotations: { title: "Screen address (AML, free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ address, network, lang }) => {
    const q = new URLSearchParams({ addr: address });
    if (network) q.set("network", network);
    if (lang) q.set("lang", lang);
    const r = await apiGet(`/api/risk?${q.toString()}`);
    const lines = [
      `Address: ${r.address}`,
      `Verdict: ${r.verdict}  |  Risk: ${r.risk}/100  |  Blocked: ${r.blocked ? "yes" : "no"}`,
      r.advice ? `Advice: ${r.advice}` : "",
      (r.signals && r.signals.length) ? `Signals:\n- ${r.signals.join("\n- ")}` : "Signals: none",
      (r.evidence && r.evidence.length)
        ? `Evidence:\n${r.evidence.map((e) => `- ${e.label}: ${e.detail}${e.url ? ` (${e.url})` : ""}`).join("\n")}`
        : "",
      `Standard: ${r.standard || "https://oceanalt.com/en/rap"}`,
    ].filter(Boolean);
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: r,
    };
  }
);

server.registerTool(
  "payee_decide",
  {
    title: "Ask the payee whether it accepts this payment (free)",
    description:
      "The other half of a safe agent payment. Before settling, ask the registered payee (by its OceanAlt registry sid — see https://oceanalt.com/registry.json) whether it accepts this incoming payment. Returns status accept | decline | hold_request_info | not_ready, machine-readable reason codes, requested_fields (only on hold), verifiable evidence and a signature. Rule-based, not model judgement: payee readiness comes from the public registry enforcement ladder (https://oceanalt.com/en/registry/rules), the payer address is screened in reverse, and amount / purpose / KYA requirements come from the payee's own policy. decline is final — re-paying does not change it. Free, no API key.",
    inputSchema: {
      payee: z.string().describe("Payee sid from the OceanAlt registry, e.g. oceanalt-200lab-premium"),
      payerAddress: z.string().optional().describe("The paying wallet address (screened in reverse)"),
      payerAgentId: z.string().optional().describe("The paying agent's KYA id, if the payee requires KYA"),
      amountUsdc: z.number().optional().describe("Amount in USDC"),
      purpose: z.string().optional().describe("Purpose of the payment, e.g. api-call"),
    },
    annotations: { title: "Payee decision (free)", readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ payee, payerAddress, payerAgentId, amountUsdc, purpose }) => {
    const r = await apiPost("/api/payee/decide", { payee, payer: { address: payerAddress, agentId: payerAgentId }, amountUsdc, purpose });
    const lines = [
      `Status: ${r.status}${r.final ? " (final)" : ""}`,
      `Reasons: ${(r.reasons || []).join(", ")}`,
      (r.requested_fields && r.requested_fields.length) ? `Requested fields: ${r.requested_fields.join(", ")}` : "",
      r.expires_at ? `Expires: ${r.expires_at}` : "",
      r.payee_ref ? `Payee: ${r.payee_ref.name} · ${r.payee_ref.rating_status} · open disputes ${r.payee_ref.open_disputes}` : "",
      r.next ? `Next: ${r.next}` : "",
      r.signature ? `Verify: ${r.signature.verify_url}` : "",
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join(String.fromCharCode(10)) }], structuredContent: r };
  }
);

server.registerTool(
  "counterparty_control_baseline",
  {
    title: "Check a counterparty's control baseline before paying (free)",
    description:
      "Answers a different question from address screening. Screening asks whether an address is risky; this asks how much damage the agent on the other side could do if it were talked into something — whether a spending ceiling exists, whether payees are restricted, whether its credential can be revoked. It returns that party's self-attestation against the OceanAlt Agent Control Baseline, split into two sets that must NOT be conflated: `verified_by_oceanalt` (controls the gateway enforces on every payment — provable) and `self_claimed` (what the party states about its own side — NOT verified by OceanAlt). IMPORTANT: most parties have not attested. A result of found:false means no information, not a bad signal — never decline a payment on that basis alone. Free, no API key.",
    inputSchema: {
      entity: z.string().optional().describe("The counterparty's entity name, e.g. \"Acme Robotics Ltd\"."),
      agentId: z.string().optional().describe("Their agent id, if you have it instead of an entity name."),
    },
    annotations: { title: "Counterparty control baseline (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ entity, agentId }) => {
    const q = new URLSearchParams();
    if (entity) q.set("entity", entity);
    if (agentId) q.set("agentId", agentId);
    if (!q.toString()) return { content: [{ type: "text", text: "Provide either entity or agentId." }], isError: true };
    const r = await apiGet(`/api/baseline/lookup?${q.toString()}`);
    const lines = r.found
      ? [
          `Party: ${r.entity || r.agentId || r.handle}`,
          `Status: ${r.status}  (mandatory ${r.mandatory_met}/${r.mandatory_total}, advisory ${r.advisory_met}/${r.advisory_total})`,
          r.missing_mandatory?.length ? `Declared gaps: ${r.missing_mandatory.join(", ")}` : "",
          r.gap_plan ? `Their plan to close them: ${r.gap_plan}` : "",
          `Verified by OceanAlt (enforced on every payment): ${(r.verified_by_oceanalt || []).join(", ") || "none"}`,
          `Self-claimed (NOT verified by OceanAlt): ${(r.self_claimed || []).join(", ") || "none"}`,
          `Attested: ${r.attested_at?.slice(0, 10) || "?"}  ·  Expires: ${r.expires_at?.slice(0, 10) || "?"}`,
        ]
      : [
          "No control-baseline attestation on record for this party.",
          "This is absence of information, not a negative signal — most parties have not attested.",
          "Do not decline on this basis alone; fall back to address screening (payment_decision).",
        ];
    return { content: [{ type: "text", text: [...lines.filter(Boolean), `Baseline: https://oceanalt.com/en/baseline`].join("\n") }], structuredContent: r };
  }
);

server.registerTool(
  "resolve_agent_identity",
  {
    title: "Resolve an agent's chain of accountability (free)",
    description:
      "Resolves who stands behind a paying agent: agent → principal → mandate → credential → wallet. Each link reports whether it holds, and `completeness` counts how many do — it is a factual count, not a score. Wherever the chain breaks is where accountability stops, which is what you actually need to know before accepting a payment from an autonomous agent. Publication is opt-in and only posture is exposed (that a ceiling exists, never its value), so found:false means the agent has not published — absence of information, not a bad signal. Free, no API key.",
    inputSchema: { agentId: z.string().describe("The agent id to resolve.") },
    annotations: { title: "Resolve agent identity (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ agentId }) => {
    const r = await apiGet(`/api/registry/agent?agentId=${encodeURIComponent(agentId)}`);
    const lines = r.found
      ? [
          `Agent: ${r.name || r.agentId}`,
          `Chain of accountability: ${r.completeness}`,
          ...["agent", "principal", "mandate", "credential", "wallet"].map(
            (k) => `  ${r.chain?.[k]?.present ? "[ok]" : "[--]"} ${k}: ${r.chain?.[k]?.detail || ""}`
          ),
          r.baseline ? `Control baseline: ${r.baseline.status}` : "",
          r.note,
        ]
      : [
          "No published record for that agent id.",
          "Publication is opt-in, so this is absence of information rather than a negative signal.",
          "Fall back to address screening (payment_decision).",
        ];
    return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], structuredContent: r };
  }
);

server.registerTool(
  "recent_flagged",
  {
    title: "List recently flagged high-risk addresses (free)",
    description:
      "Return a representative sample of addresses on OceanAlt's reviewed risk list — OFAC-sanctioned, known mixers, and community-reported scam/phishing — each with its source category and the reason it was flagged. Useful for grounding, showing an agent/user what gets blocked and why, or a quick read on the current threat surface. Takes no arguments. Free, no API key.",
    inputSchema: {},
    annotations: { title: "Recent flagged addresses (free)", readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    const r = await apiGet(`/api/risk/recent`);
    const items = Array.isArray(r) ? r : (r.items || []);
    // Live shape: { total, items:[{ address, source, sourceLabel, sourceLabelEn, reason }] }.
    // Fallbacks keep it robust if the response shape ever changes.
    const fmt = (it) => {
      const addr = it.address || it.addr || "";
      const label = it.sourceLabelEn || it.sourceLabel || it.source || it.verdict || "";
      const reason = it.reason || (it.signals && it.signals[0]) || it.top || "";
      return `- ${addr}${label ? ` | ${label}` : ""}${reason ? ` | ${reason}` : ""}`;
    };
    const header = (!Array.isArray(r) && typeof r.total === "number") ? `Total on risk list: ${r.total}\nSample:\n` : "";
    const text = items.length ? header + items.slice(0, 20).map(fmt).join("\n") : "No flagged addresses available.";
    return { content: [{ type: "text", text }], structuredContent: r };
  }
);

server.registerTool(
  "payment_decision",
  {
    title: "Decide whether to pay an address before an agent pays (free)",
    description:
      "\"Before your agent pays, call OceanAlt once.\" Pass the payee address the agent is about to pay; get a machine-executable decision: allow | review | decline, plus verifiable evidence and retry semantics. Use this as a gate in an autonomous payment flow — if the decision is not \"allow\", do not pay. On allow/review it also returns a verifiable compliance attestation you can attach to the settlement so the payment carries proof it passed OceanAlt's decision. Free, no API key, no signup. (For the paid variant that also settles the payment on x402 rails, use compliance_decision.)",
    inputSchema: {
      to: z.string().describe("Payee address the agent is about to pay. EVM: 0x + 40 hex. Tron: T + 33 base58."),
      amountUsdc: z.number().optional().describe("Amount in USDC (optional; recorded/echoed, not required for the decision)."),
      purpose: z.string().optional().describe("Short purpose/memo for the payment (optional)."),
      network: z.enum(NETWORKS).optional().describe("EVM chain for the payee (same set as screen_address). Optional; ignored for Tron."),
      lang: z.enum(["en", "zh"]).optional().describe("Language for human-readable fields (signals, note, advice). Defaults to English."),
    },
    annotations: { title: "Payment decision (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ to, amountUsdc, purpose, network, lang }) => {
    const q = new URLSearchParams({ to });
    if (amountUsdc != null) q.set("amountUsdc", String(amountUsdc));
    if (purpose) q.set("purpose", purpose);
    if (network) q.set("network", network);
    if (lang) q.set("lang", lang);
    const r = await apiGet(`/api/decide?${q.toString()}`);
    const lines = [
      `Decision: ${r.decision}  (allow=${r.allow})`,
      `Address: ${r.address}  |  Verdict: ${r.verdict}  |  Risk: ${r.risk == null ? "n/a" : r.risk + "/100"}`,
      r.advice ? `Advice: ${r.advice}` : "",
      r.retry_hint ? `Retry: ${r.retry_hint}` : "",
      (r.signals && r.signals.length) ? `Signals:\n- ${r.signals.join("\n- ")}` : "",
      (r.evidence && r.evidence.length)
        ? `Evidence:\n${r.evidence.map((e) => `- ${e.label}: ${e.detail}${e.url ? ` (${e.url})` : ""}`).join("\n")}`
        : "",
      r.disclaimer ? `Note: ${r.disclaimer}` : "",
      r.settlement ? `Attestation (attach to your settlement): ${r.settlement.attestation_id}  ·  verify: ${r.settlement.verify_url}` : "",
      `Standard: ${r.standard || "https://oceanalt.com/en/rap"}`,
    ].filter(Boolean);
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: r };
  }
);

// ── 0.6.0 (2026-09-14): three more free tools, mirroring the remote server at /api/mcp ──
server.registerTool(
  "check_calldata_intent",
  {
    title: "Decode a transaction and compare with declared intent (free)",
    description:
      "Anti blind-signing. EVM: decodes what calldata will actually do (ERC-20 transfer/approve/permit, setApprovalForAll, ownership transfer, native transfer). Solana: decodes a whole base64 transaction (SPL Token / Token-2022 Transfer, TransferChecked, Approve, SetAuthority, CloseAccount, Burn; System Transfer / Assign; ATA creation). Compares it with the payment the agent believes it is making. decision match = does what you declared; mismatch = different recipient/amount/asset, or an approval / authority change instead of a payment — do not sign; unknown = could not decode (including address-lookup-table accounts), which is NOT the same as safe. Free, no API key.",
    inputSchema: {
      intent: z.object({ action: z.literal("pay"), to: z.string().describe("EVM: recipient. Solana: wallet or token account."), amount: z.string().optional().describe("Base units, e.g. 10 USDC = 10000000"), asset: z.string().optional().describe("EVM: symbol/contract. Solana: mint address (checked against TransferChecked)") }).optional(),
      contract: z.string().optional().describe("EVM only: the transaction's `to` (token contract, or the recipient for native transfers)."),
      data: z.string().optional().describe("EVM only: 0x-prefixed hex calldata."),
      value: z.string().optional().describe("EVM only: native value in wei."),
      network: z.string().optional().describe("'solana' to decode a Solana transaction; EVM chain name or CAIP-2 id otherwise."),
      transaction: z.string().optional().describe("Solana only: base64-serialized transaction or message."),
    },
    annotations: { title: "Check intent (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ intent, contract, data, value, network, transaction }) => {
    if (!transaction && !data) return { content: [{ type: "text", text: "Pass data (EVM calldata) or network:'solana' + transaction (base64)." }], isError: true };
    const r = await apiPost("/api/intent/check", transaction ? { intent, network: network || "solana", transaction } : { intent, contract, data, value, network });
    if (r.error) return { content: [{ type: "text", text: String(r.error) }], isError: true };
    const text = [`Decision: ${r.decision}  (${r.reason_code})`, r.en || r.note || "", r.actions ? `Actions: ${r.actions.map((a) => a.en).join(" | ")}` : (r.decoded && r.decoded.en ? `Decoded: ${r.decoded.en}` : ""), r.notes && r.notes.length ? `Notes: ${r.notes.join("; ")}` : ""].filter(Boolean).join("\n");
    return { content: [{ type: "text", text }], structuredContent: r };
  }
);

server.registerTool(
  "verify_payment_requirements",
  {
    title: "Verify a signed x402 402 response was not tampered with (free)",
    description:
      "A 402 response is plaintext: any hop between seller and agent (proxy, CDN, a compromised SDK, a malicious tool) can swap the payTo address. Sellers who sign their payment requirements with OceanAlt put extensions.signedRequirements (Ed25519) inside the PAYMENT-REQUIRED header payload. Pass the decoded header JSON (or its raw base64) and, optionally, the payTo / amount you expect; get verified true/false with a reason code: ok | no_signature | digest_mismatch | signature_invalid | key_unavailable | payto_mismatch | amount_mismatch. Defends against tampering in transit, not against a compromised seller origin. Free, no API key.",
    inputSchema: {
      payment_required: z.any().describe("The decoded PAYMENT-REQUIRED JSON, or the raw base64 header value."),
      keys_url: z.string().optional().describe("Where the seller publishes its keys (defaults to the keys_url inside the signature)."),
      expect: z.object({ payTo: z.string().optional(), amount: z.string().optional() }).optional().describe("What you expect to pay; mismatches are reported."),
    },
    annotations: { title: "Verify signed 402 (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ payment_required, keys_url, expect }) => {
    const r = await apiPost("/api/x402/verify-requirements", { body: payment_required, keys_url, expect });
    if (r.error) return { content: [{ type: "text", text: String(r.error) }], isError: true };
    return { content: [{ type: "text", text: `Verified: ${r.verified}  (${r.reason_code})\n${r.detail || ""}${r.keys_url ? `\nKeys: ${r.keys_url} (${r.keys_fetched} fetched)` : ""}` }], structuredContent: r };
  }
);

server.registerTool(
  "evidence_bundle",
  {
    title: "Signed evidence bundle for an address (free)",
    description:
      "Everything OceanAlt can say about an address, in one Ed25519-signed bundle you can verify offline: screening verdict + evidence + freshness, self-built profile signals, one-hop relations to listed addresses, fulfillment receipt stats. OceanAlt is a witness, not a plaintiff: no conclusions, no attribution of persons, every item carries its source and coverage date. Everything inside is already public; there is no user data and no privileged channel — anyone may request one. Free, 10 per minute.",
    inputSchema: {
      address: z.string().describe("EVM (0x…), Solana / Tron (base58) or Bitcoin address."),
      network: z.string().optional().describe("Chain, e.g. ethereum, base, solana (optional)."),
    },
    annotations: { title: "Evidence bundle (free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ address, network }) => {
    const q = new URLSearchParams({ address }); if (network) q.set("network", network);
    const r = await apiGet(`/api/evidence/bundle?${q.toString()}`);
    const b = r.bundle || {};
    const s = b.screening || {};
    const asOf = s.evidence_as_of == null ? "?" : typeof s.evidence_as_of === "string" ? s.evidence_as_of : JSON.stringify(s.evidence_as_of);
    const text = [`Subject: ${b.subject?.address}${b.subject?.network ? " on " + b.subject.network : ""}`, `Stance: ${b.stance}`, s.unavailable ? "Screening: unavailable" : `Screening: ${s.verdict} (risk ${s.risk ?? "n/a"}, blocked ${s.blocked ? "yes" : "no"}) · evidence as of ${asOf}`, `Profile signals: ${(b.profile_signals || []).length} · one-hop relations: ${(b.one_hop_relations || []).length} · verified receipts: ${b.fulfillment?.verified_receipts ?? 0}`, `Signature: ${r.signature ? "present (verify with " + (r.verify?.keys_url || "") + ")" : "missing"}`].join("\n");
    return { content: [{ type: "text", text }], structuredContent: r };
  }
);

// ── Paid (x402) tools ────────────────────────────────────────────────────────
// Require a payer wallet private key (env OCEANALT_PAYER_KEY, 0x-prefixed) plus the on-demand deps
// @x402/core @x402/evm viem. Like the official SDK: the MCP signs one EIP-3009 authorization; the
// facilitator verifies, settles, and pays gas — funds are never custodied.
const PAYER_KEY = process.env.OCEANALT_PAYER_KEY || "";

async function payFetch(method, path, body) {
  if (!PAYER_KEY) throw new Error("Paid endpoint (x402): set OCEANALT_PAYER_KEY (payer wallet private key) in your MCP env to enable it — it signs one EIP-3009 USDC authorization locally; the facilitator pays gas. Without it, only the free tools screen_address / recent_flagged are available.");
  let x402core, x402evm, viemAccounts;
  try {
    [x402core, x402evm, viemAccounts] = await Promise.all([
      import("@x402/core/client"), import("@x402/evm/exact/client"), import("viem/accounts"),
    ]);
  } catch {
    throw new Error("Paid tools need extra deps: run `npm i @x402/core @x402/evm viem` in the MCP's environment.");
  }
  const account = viemAccounts.privateKeyToAccount(PAYER_KEY);
  const client = new x402core.x402Client();
  x402evm.registerExactEvmScheme(client, { signer: account });
  const http = new x402core.x402HTTPClient(client);
  const url = BASE + path;
  const init = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r1 = await fetch(url, { ...init, signal: ctrl.signal });
    if (r1.status !== 402) return { data: await r1.json().catch(() => null), status: r1.status, paid: false }; // not gated, or already allowed
    const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n));
    const payload = await http.createPaymentPayload(pr);
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const r2 = await fetch(url, { ...init, headers: { ...init.headers, ...payHeaders }, signal: ctrl.signal });
    const data = await r2.json().catch(() => null);
    let settlement = null;
    try { settlement = http.getPaymentSettleResponse((n) => r2.headers.get(n)); } catch { /* no receipt */ }
    return { data, status: r2.status, paid: r2.status === 200, settlement };
  } finally { clearTimeout(t); }
}

function payText(title, r) {
  const head = r.paid ? `Paid and settled${r.settlement ? " (on-chain receipt attached)" : ""}` : r.status === 402 ? "Payment required but not settled" : `HTTP ${r.status}`;
  return `[${title}] ${head}\n${JSON.stringify(r.data, null, 2)}`;
}

server.registerTool(
  "compliance_decision",
  {
    title: "Gateway compliance decision for a payment (paid, x402 $0.30)",
    description:
      "Run OceanAlt's full compliance gateway on a proposed payment and get a DECISION — allow | review | decline — plus advice and verifiable evidence, not just raw data. Combines AML screening of the payee with RAP (Responsible Agentic Payments) gate checks. Use this when an agent needs a go/no-go call before releasing funds. PAID via x402: the first request returns HTTP 402, this server automatically signs one USDC authorization and retries — this moves REAL money and requires OCEANALT_PAYER_KEY. Costs $0.30 in real USDC settled on Base mainnet (eip155:8453). Always confirm the live network/price at https://oceanalt.com/api/x402 and use a dedicated low-balance payer wallet.",
    inputSchema: {
      to: z.string().describe("Payee address the agent intends to pay. EVM (0x + 40 hex) or Tron (T + 33 base58)."),
      amountUsdc: z.number().optional().describe("Payment amount in USDC. Optional; used only for record / mandate-limit checks, not required to get a decision."),
      purpose: z.string().optional().describe("Short free-text note on what the payment is for. Optional (max ~120 chars)."),
      network: z.enum(NETWORKS).optional().describe("EVM chain for the payee (same set as screen_address). Optional; ignored for Tron."),
    },
    annotations: { title: "Compliance decision (paid $0.30)", readOnlyHint: false, openWorldHint: true },
  },
  async ({ to, amountUsdc, purpose, network }) => {
    const r = await payFetch("POST", "/api/x402/decision", { to, amountUsdc, purpose, network });
    return { content: [{ type: "text", text: payText("Gateway compliance decision", r) }], structuredContent: r };
  }
);

server.registerTool(
  "deep_trace",
  {
    title: "Deep taint trace of a Tron address (paid, x402 $0.20)",
    description:
      "Trace a Tron (TRON) USDT address up to 3 hops back along its largest incoming transfers to see whether its funds touch a Tether-frozen, sanctioned, mixer, or scam address upstream — deeper than a single-address screen. Tron only (T…). PAID via x402: moves REAL money and requires OCEANALT_PAYER_KEY. Costs $0.20 in real USDC settled on Base mainnet (eip155:8453) — confirm the live network/price at https://oceanalt.com/api/x402 and use a dedicated low-balance payer wallet. Note: follows only the main funds path, depth ≤3, not exhaustive — no hit does not prove the address is clean.",
    inputSchema: { address: z.string().describe("Tron address to trace (T + 33 base58). USDT on TRON.") },
    annotations: { title: "Deep taint trace (paid $0.20)", readOnlyHint: false, openWorldHint: true },
  },
  async ({ address }) => {
    const r = await payFetch("GET", `/api/x402/trace?addr=${encodeURIComponent(address)}`);
    return { content: [{ type: "text", text: payText("Deep taint trace", r) }], structuredContent: r };
  }
);

server.registerTool(
  "batch_screen",
  {
    title: "Batch-screen up to 25 addresses (paid, x402 $0.10)",
    description:
      "Screen up to 25 blockchain addresses in a single call. Returns a per-address verdict (clear | caution | risky | invalid), risk score, blocked flag, and top signal, plus a summary count, sorted risky-first. Cheaper per address than screening one at a time. EVM (0x…) and Tron (T…). PAID via x402: moves REAL money and requires OCEANALT_PAYER_KEY. Costs $0.10 in real USDC settled on Base mainnet (eip155:8453) — confirm the live network/price at https://oceanalt.com/api/x402 and use a dedicated low-balance payer wallet.",
    inputSchema: { addresses: z.array(z.string()).max(25).describe("Addresses to screen (max 25), each 0x… (EVM) or T… (Tron). Duplicates and blank entries are ignored.") },
    annotations: { title: "Batch screen (paid $0.10)", readOnlyHint: false, openWorldHint: true },
  },
  async ({ addresses }) => {
    const r = await payFetch("POST", "/api/x402/batch", { addresses });
    return { content: [{ type: "text", text: payText("Batch address screen", r) }], structuredContent: r };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// Once connected, don't print to stdout (stdio transport owns it); diagnostics go to stderr.
console.error(`[oceanalt-aml-mcp] v${PKG_VERSION} started, base = ${BASE}, paid tools ${PAYER_KEY ? "enabled" : "disabled (OCEANALT_PAYER_KEY not set — free tools only)"}`);
