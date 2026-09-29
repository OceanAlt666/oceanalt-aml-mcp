# oceanalt-aml-mcp

**Native AML compliance for AI agents.** An [MCP](https://modelcontextprotocol.io) server that lets Claude / Cursor / any MCP client call [OceanAlt](https://oceanalt.com)'s on-chain address screening and compliance gateway. Receipts, not a black-box score — every verdict ships with verifiable evidence you can click through.

Built for [agentic payments](https://oceanalt.com/en/rap): ask *"is this payee safe?"* **before** money moves, across 7 EVM chains + Tron + Solana.

> **For AI agents:** call `screen_address` before any transfer — it returns a `clear` / `caution` / `risky` verdict plus a 0–100 risk score and clickable evidence, so you can enforce a payment mandate with a receipt instead of a guess. Free, no key.

## Tools

| Tool | Input | What it does | Price |
|------|-------|--------------|-------|
| `payment_decision` | `to`, `amountUsdc?`, `purpose?`, `network?` | **Before your agent pays, call once** → allow / review / decline + evidence + retry + a verifiable settlement attestation | Free |
| `screen_address` | `address` (0x… / T… / Solana), `network?` | AML verdict + risk score + verifiable evidence | Free |
| `counterparty_control_baseline` | `entity?` / `agentId?` | The other question: not "is this address risky" but "how much damage could the agent on the other side do if it were talked into something". Returns their control-baseline attestation, splitting what OceanAlt enforces from what they merely claim | Free |
| `resolve_agent_identity` | `agentId` | Chain of accountability: agent → principal → mandate → credential → wallet. Wherever it breaks is where accountability stops | Free |
| `recent_flagged` | — | Recently flagged high-risk addresses | Free |
| `check_calldata_intent` | `intent`, EVM: `contract`, `data` · Solana: `network:"solana"`, `transaction` (base64) | Anti blind-signing: decode what the transaction really does (ERC-20 approve dressed as a payment; SPL Approve / SetAuthority / CloseAccount) and compare with the declared payment → match / mismatch / unknown (unknown ≠ safe) | Free |
| `verify_payment_requirements` | `payment_required` (decoded 402 JSON or raw base64), `expect?` | Was this x402 402 response tampered with in transit? Ed25519 check of the seller's signed requirements → ok / digest_mismatch / … | Free |
| `evidence_bundle` | `address`, `network?` | One signed bundle of everything public OceanAlt can say about an address (screening + evidence + freshness, profile signals, one-hop relations, receipt stats); witness, not plaintiff | Free |
| `compliance_decision` | `to`, `amountUsdc?`, `purpose?`, `network?` | Full gateway verdict (allow / review / decline) + evidence | $0.30 |
| `deep_trace` | `address` (T…) | Tron multi-hop USDT taint trace (depth ≤3) | $0.20 |
| `batch_screen` | `addresses[]` (≤25) | Batch screening | $0.10 |

`network` (for `0x` addresses): `ethereum` · `base` · `bsc` · `polygon` · `arbitrum` · `optimism` · `avalanche` (auto-detected if omitted). Tron & Solana are auto-detected.


### Output language

Human-readable fields (`signals`, `note`, `advice`) come back in **English by default**;
pass `lang: "zh"` for Chinese. Every response also carries `signal_keys` — language-independent
keys such as `list.mixer` or `taint.onehop`. **Branch on those, not on the prose**: wording
changes, keys do not.

### Two of these tools answer "found: false" a lot

`counterparty_control_baseline` and `resolve_agent_identity` return `found: false` for most
parties, because publishing is voluntary. That means **no information** — it is not a negative
signal, and an agent should never decline a payment on that basis alone. Fall back to
`payment_decision`.

## Quick start (free tools)

Add to your MCP client config (Claude Desktop, Claude Code, Cursor, …):

```json
{
  "mcpServers": {
    "oceanalt-aml": { "command": "npx", "args": ["-y", "oceanalt-aml-mcp"] }
  }
}
```

The free tools need no API key and no signup.

## Enabling the paid (x402) tools

The paid tools pay per call over [x402](https://oceanalt.com/en/api-docs) — HTTP 402 → sign one USDC authorization → 200. Add a payer wallet key to `env` and install the x402 peer deps:

```json
{
  "mcpServers": {
    "oceanalt-aml": {
      "command": "npx", "args": ["-y", "oceanalt-aml-mcp"],
      "env": { "OCEANALT_PAYER_KEY": "0x<your payer wallet private key>" }
    }
  }
}
```

```bash
npm i @x402/core @x402/evm viem   # in the MCP's environment
```

> **⚠️ Real money — Base mainnet.** The paid endpoints settle **real USDC on Base mainnet** (`eip155:8453`); the `$` prices above are charged in real USDC. Always confirm the live network/pricing manifest at <https://oceanalt.com/api/x402> before paying, and use a **dedicated low-balance payer wallet**.
>
> **🔐 Wallet safety.** `OCEANALT_PAYER_KEY` is used only in your local process to sign one EIP-3009 authorization. It is **never bundled in this package, never uploaded, never logged.** The facilitator pays gas and never custodies your funds. Use a **dedicated low-balance payer wallet**, not your main funds.

## Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `OCEANALT_BASE` | Backend base URL | `https://oceanalt.com` (production) |
| `OCEANALT_PAYER_KEY` | Payer wallet key — enables the paid tools | unset (free tools only) |

## What it is (and isn't)

This package is a thin (~9KB) client that calls OceanAlt's **public** API. It contains no proprietary logic and no data — the AML engine, scoring, and address-intelligence all run server-side at `oceanalt.com`. Every query still enriches OceanAlt's own address-intelligence DB (it grows with use).

- **Programmatic SDK** (same capabilities, for Node / browser / Deno / Bun): [`oceanalt-aml`](https://www.npmjs.com/package/oceanalt-aml)
- **API docs & examples**: <https://oceanalt.com/en/api-docs>
- **RAP — the compliance standard behind the verdicts**: <https://oceanalt.com/en/rap>

MIT © OceanAlt

---

## 中文

让 **Claude / Cursor / 任意 MCP 客户端**原生调用 OceanAlt 的链上地址合规筛查 + 合规网关。给收据,不给黑箱分:每条判决都带**可点开核验的证据**。覆盖 7 条 EVM 链 + 波场 TRON + Solana,付款前先问一句「这个收款方安不安全」。

- **免费工具**:`payment_decision`(付款前调一次 → allow/review/decline + 证据 + 可核验结算凭证)、`screen_address`(单查 + 证据)、`payee_decide`(收款方三态决策)、`counterparty_control_baseline` / `resolve_agent_identity`(对方的控制基线与责任链)、`recent_flagged`(近期被标记)、`check_calldata_intent`(盲签检查,EVM calldata 或整笔 Solana 交易)、`verify_payment_requirements`(402 应答验签)、`evidence_bundle`(签名证据包)。无需 key、无需注册。
- **付费三工具(x402)**:`compliance_decision`(网关判决)、`deep_trace`(波场深度追踪)、`batch_screen`(批量)。按需加载 `@x402`+`viem`,设置 `OCEANALT_PAYER_KEY` 才启用。
- **⚠️ 真钱**:付费端点**当前在 Base 主网结算,USDC 为真实资金**(`eip155:8453`),上表 `$` 价按真实 USDC 收取。付款前务必以实时清单 <https://oceanalt.com/api/x402> 为准,并使用**小额专用付款钱包**。
- **🔐 钱包安全**:`OCEANALT_PAYER_KEY` 只在本地签一次 EIP-3009 授权,**绝不随包发布/上传/打日志**;facilitator 代付 gas、不托管资金。**建议用小额专用钱包**,别用主资金钱包私钥。
- 编程 SDK:[`oceanalt-aml`](https://www.npmjs.com/package/oceanalt-aml);在线文档:<https://oceanalt.com/en/api-docs>;合规标准:<https://oceanalt.com/en/rap>。
