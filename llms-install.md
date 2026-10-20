# Installing the OceanAlt MCP server

OceanAlt gives an AI agent pre-payment checks: before paying, it returns allow, review or decline with evidence. All tools used below are free and need no API key or signup.

## Option 1: remote server (recommended, nothing to install)

Add a remote MCP server with this URL (transport: streamable HTTP):

```
https://oceanalt.com/api/mcp
```

For clients that use a JSON config (Cline, Cursor, Claude Desktop and similar):

```json
{
  "mcpServers": {
    "oceanalt": {
      "type": "streamableHttp",
      "url": "https://oceanalt.com/api/mcp"
    }
  }
}
```

If your client does not support remote servers, use option 2.

## Option 2: local server over stdio (Node.js 18+)

```json
{
  "mcpServers": {
    "oceanalt": {
      "command": "npx",
      "args": ["-y", "oceanalt-aml-mcp"]
    }
  }
}
```

No environment variables are needed for the free tools. The paid tools (compliance_decision, deep_trace, batch_screen) stay disabled unless you set OCEANALT_PAYER_KEY, and they spend real USDC; you do not need them.

## Check that it works

Call `payment_decision` with:

```json
{ "to": "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b", "network": "ethereum" }
```

That address is a known mixer, so the answer is `decline` with the matching list as evidence.

## When to call it

Call `payment_decision` before any payment the agent makes. Also call `screen_endpoint` on the payment page URL, and `check_payment_request` when an email, invoice or message asks for payment. If any answer is not `allow`, do not pay.
