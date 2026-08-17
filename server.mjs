#!/usr/bin/env node
// OceanAlt AML —— MCP server。让 Claude / 任意 MCP 客户端「原生」调用地址合规筛查 + 合规网关。
// v0.2:免费两工具(单查 + 近期名单,零重依赖)+ 三个 x402 付费工具(网关判决/深度追踪/批量)。
//   → 目标:成为 agent 手边「绕不开的默认合规检查」;每次调用还在喂厚 OceanAlt 自建情报库。
//   → 付费工具按需加载 @x402 + viem,仅当设置了付款钱包私钥(OCEANALT_PAYER_KEY)才启用;
//     未设/未装依赖时付费工具返回清晰提示、绝不崩溃,免费工具始终可用。facilitator 代验签+代结算,不托管资金。
//
// 接入(Claude Desktop 等)配置示例:
//   { "mcpServers": { "oceanalt-aml": { "command": "npx", "args": ["-y", "oceanalt-aml-mcp"],
//       "env": { "OCEANALT_PAYER_KEY": "0x…(选填,启用付费工具)" } } } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.OCEANALT_BASE || "https://oceanalt.com").replace(/\/$/, "");
const TIMEOUT = 15000;
// 支持的 EVM 链(与站点 lib/aml.ts 的 EVM_NETS 对齐:实测可用才在此列出)
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
    title: "地址合规筛查(免费)",
    description:
      "对一个区块链地址做 AML 合规筛查:制裁/混币器/诈骗名单命中、发行方(USDT/USDC)冻结、链上启发式风险,并给出可核验证据与 allow/caution/decline 倾向。支持 EVM(0x…)、TRON(T…)、Solana。免费、无需 key。",
    inputSchema: {
      address: z.string().describe("要筛查的地址:0x…(EVM)/ T…(TRON)/ Solana base58"),
      network: z
        .enum(NETWORKS)
        .optional()
        .describe("EVM 链(可选,不填按地址推断):ethereum/base/bsc/polygon/arbitrum/optimism/avalanche"),
    },
  },
  async ({ address, network }) => {
    const q = new URLSearchParams({ addr: address });
    if (network) q.set("network", network);
    const r = await apiGet(`/api/risk?${q.toString()}`);
    const lines = [
      `地址: ${r.address}`,
      `判决: ${r.verdict}  |  风险分: ${r.risk}/100  |  可转出被拦: ${r.blocked ? "是" : "否"}`,
      r.advice ? `建议: ${r.advice}` : "",
      (r.signals && r.signals.length) ? `信号:\n- ${r.signals.join("\n- ")}` : "信号: 无",
      (r.evidence && r.evidence.length)
        ? `证据:\n${r.evidence.map((e) => `- ${e.label}: ${e.detail}${e.url ? ` (${e.url})` : ""}`).join("\n")}`
        : "",
      `标准: ${r.standard || "https://oceanalt.com/en/rap"}`,
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
    title: "近期被标记的敏感地址(免费)",
    description: "返回 OceanAlt 近期筛出的高风险/被标记地址案例,用于快速了解当前威胁面。免费。",
    inputSchema: {},
  },
  async () => {
    const r = await apiGet(`/api/risk/recent`);
    const items = Array.isArray(r) ? r : (r.items || []);
    const text = items.length
      ? items.slice(0, 20).map((it) => `- ${it.address || it.addr} | ${it.verdict || ""} | ${(it.signals && it.signals[0]) || it.top || ""}`).join("\n")
      : "近期无被标记地址。";
    return { content: [{ type: "text", text }], structuredContent: r };
  }
);

// ── 付费(x402)工具 ──────────────────────────────────────────────────────────
// 需付款钱包私钥(环境变量 OCEANALT_PAYER_KEY,0x 开头)+ 按需依赖 @x402/core @x402/evm viem。
// 设计同官方 SDK:MCP 只用私钥签一次 EIP-3009 授权,facilitator 代验签+代结算+代付 gas,不托管资金。
const PAYER_KEY = process.env.OCEANALT_PAYER_KEY || "";

async function payFetch(method, path, body) {
  if (!PAYER_KEY) throw new Error("此为付费端点(x402):请在 MCP 配置的 env 里设置 OCEANALT_PAYER_KEY(付款钱包私钥,签 EIP-3009 授权;facilitator 代付 gas)。未设置则仅免费工具 screen_address / recent_flagged 可用。");
  let x402core, x402evm, viemAccounts;
  try {
    [x402core, x402evm, viemAccounts] = await Promise.all([
      import("@x402/core/client"), import("@x402/evm/exact/client"), import("viem/accounts"),
    ]);
  } catch {
    throw new Error("付费工具需要依赖:在 MCP 所在环境执行 npm i @x402/core @x402/evm viem。");
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
    if (r1.status !== 402) return { data: await r1.json().catch(() => null), status: r1.status, paid: false }; // 未开启付费或已放行
    const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n));
    const payload = await http.createPaymentPayload(pr);
    const payHeaders = http.encodePaymentSignatureHeader(payload);
    const r2 = await fetch(url, { ...init, headers: { ...init.headers, ...payHeaders }, signal: ctrl.signal });
    const data = await r2.json().catch(() => null);
    let settlement = null;
    try { settlement = http.getPaymentSettleResponse((n) => r2.headers.get(n)); } catch { /* 无回执 */ }
    return { data, status: r2.status, paid: r2.status === 200, settlement };
  } finally { clearTimeout(t); }
}

function payText(title, r) {
  const head = r.paid ? `✅ 已付费并结算${r.settlement ? "(附链上回执)" : ""}` : r.status === 402 ? "⚠️ 需付费但未完成结算" : `状态 HTTP ${r.status}`;
  return `【${title}】${head}\n${JSON.stringify(r.data, null, 2)}`;
}

server.registerTool(
  "compliance_decision",
  {
    title: "网关合规判决(付费 $0.30)",
    description: "对一笔待支付跑完整合规网关:AML 筛查 + RAP 各闸门 + allow/review/decline 判决 + 可核验证据。付费端点(x402,$0.30 USDC;当前 Base Sepolia 测试网结算、为测试币),需 OCEANALT_PAYER_KEY。",
    inputSchema: {
      to: z.string().describe("收款地址:0x…(EVM)或 T…(TRON)"),
      amountUsdc: z.number().optional().describe("金额(USDC,选填,仅作记录/额度判断)"),
      purpose: z.string().optional().describe("用途备注(选填)"),
      network: z.enum(NETWORKS).optional().describe("EVM 链(选填)"),
    },
  },
  async ({ to, amountUsdc, purpose, network }) => {
    const r = await payFetch("POST", "/api/x402/decision", { to, amountUsdc, purpose, network });
    return { content: [{ type: "text", text: payText("网关合规判决", r) }], structuredContent: r };
  }
);

server.registerTool(
  "deep_trace",
  {
    title: "深度沾染追踪(付费 $0.20)",
    description: "对一个波场(TRON)地址做多跳 USDT 沾染回溯(depth ≤3):资金是否触及被 Tether 冻结/制裁的黑地址。付费端点(x402,$0.20 USDC;当前 Base Sepolia 测试网结算、为测试币),需 OCEANALT_PAYER_KEY。",
    inputSchema: { address: z.string().describe("波场地址 T…") },
  },
  async ({ address }) => {
    const r = await payFetch("GET", `/api/x402/trace?addr=${encodeURIComponent(address)}`);
    return { content: [{ type: "text", text: payText("深度沾染追踪", r) }], structuredContent: r };
  }
);

server.registerTool(
  "batch_screen",
  {
    title: "批量地址筛查(付费 $0.10)",
    description: "一次筛查多个地址(≤25),返回每个地址的判决/风险分/信号。付费端点(x402,$0.10 USDC;当前 Base Sepolia 测试网结算、为测试币),需 OCEANALT_PAYER_KEY。",
    inputSchema: { addresses: z.array(z.string()).max(25).describe("地址数组(≤25):0x…/T…") },
  },
  async ({ addresses }) => {
    const r = await payFetch("POST", "/api/x402/batch", { addresses });
    return { content: [{ type: "text", text: payText("批量地址筛查", r) }], structuredContent: r };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// 连上后不打印到 stdout(stdio 传输占用 stdout);诊断信息走 stderr。
console.error(`[oceanalt-aml-mcp] v0.2 已启动,base = ${BASE},付费工具 ${PAYER_KEY ? "已启用" : "未启用(未设 OCEANALT_PAYER_KEY,仅免费工具)"}`);
