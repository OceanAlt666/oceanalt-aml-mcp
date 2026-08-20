#!/usr/bin/env node
// OceanAlt AML — MCP server. Lets Claude / Cursor / any MCP client natively call
// OceanAlt's on-chain address screening + compliance gateway. Ask "is this payee safe?"
// BEFORE money moves — verdicts ship with clickable, verifiable evidence, not a black-box score.
//
// Two free tools (single screen + recent flagged list, no key, no signup) and three optional
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

const BASE = (process.env.OCEANALT_BASE || "https://oceanalt.com").replace(/\/$/, "");
const TIMEOUT = 15000;
// Supported EVM chains — kept in lockstep with the site's lib/aml.ts EVM_NETS (only chains proven live).
const NETWORKS = ["ethereum", "base", "bsc", "polygon", "arbitrum", "optimism", "avalanche"];

async function apiGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(BASE + path, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`OceanAlt ${path} → HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const server = new McpServer({ name: "oceanalt-aml", version: "0.2.0" });

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
    },
    annotations: { title: "Screen address (AML, free)", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ address, network }) => {
    const q = new URLSearchParams({ addr: address });
    if (network) q.set("network", network);
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
console.error(`[oceanalt-aml-mcp] v0.2 started, base = ${BASE}, paid tools ${PAYER_KEY ? "enabled" : "disabled (OCEANALT_PAYER_KEY not set — free tools only)"}`);
