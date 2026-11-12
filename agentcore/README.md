# OceanAlt with Amazon Bedrock AgentCore

AgentCore payments can sign x402 payments for your agent. OceanAlt checks the payee before AgentCore signs: allow, review or decline, with the reasons and evidence. With this integration, AgentCore does the signing; the OceanAlt policy only answers whether to go ahead, and it does not hold funds.

## Gate signing with pre_sign_policy

AgentCore calls `pre_sign_policy` before it signs a payment and signs only if the policy returns exactly `True`. The policy below returns `True` only when OceanAlt answers `allow` for every payee in the payment request.

Install this version and the SDK for your framework (the SDK and frameworks need Python 3.10+; the OceanAlt client itself has no third-party dependencies). The pins are the combination this release was verified with; other versions may also work:

    pip install "oceanalt-aml==0.1.3" "bedrock-agentcore==1.26.0" "strands-agents==1.64.0"                      # Strands
    pip install "oceanalt-aml==0.1.3" "bedrock-agentcore==1.26.0" "langchain==1.4.10" "langgraph==1.2.20"   # LangGraph

Strands:

    from strands import Agent
    from bedrock_agentcore.payments.integrations.strands import AgentCorePaymentsPlugin, AgentCorePaymentsPluginConfig
    from oceanalt_aml import agentcore_pre_sign_policy

    config = AgentCorePaymentsPluginConfig(
        payment_manager_arn="arn:aws:...",
        user_id="user-123",
        payment_instrument_id="instrument-456",
        payment_session_id="session-789",
        pre_sign_policy=agentcore_pre_sign_policy,
    )
    agent = Agent(tools=[...], plugins=[AgentCorePaymentsPlugin(config)])

LangGraph (LangChain `create_agent`):

    from langchain.agents import create_agent
    from bedrock_agentcore.payments.integrations.langgraph import AgentCorePaymentsMiddleware, AgentCorePaymentsConfig
    from oceanalt_aml import agentcore_pre_sign_policy

    config = AgentCorePaymentsConfig(payment_manager_arn="arn:aws:...", user_id="user-123",
                                     payment_instrument_id="instrument-456", payment_session_id="session-789",
                                     pre_sign_policy=agentcore_pre_sign_policy)
    agent = create_agent(model=..., tools=[...], middleware=[AgentCorePaymentsMiddleware(config)])

Only integrations whose config carries this policy are gated. Installing or importing the package changes nothing by itself.

### What the policy checks

The payee address and network of each offer, and nothing else. It does not check the amount, the asset, the merchant's origin or any other payment condition. An allow means the payee passed this check; it does not approve the whole payment.

### What the policy accepts and blocks

- Accepts an unambiguous x402 v1 request (JSON body with `x402Version` 1) or x402 v2 request (base64 `Payment-Required` header with `x402Version` 2 and CAIP-2 networks).
- Blocks MPP challenges, a request carrying both v1 and v2 requirements, any entry without a payee or network, a v2 network that is not a valid CAIP-2 id, a duplicate JSON key, base64 that is not strictly valid, a version that does not match where it was found, more than 10 offers, a decline or review, a timeout, an HTTP error and any other exception.
- Checks every offered payee, because AgentCore may pick any of them. An identical (payTo, network) pair is looked up once.
- Each lookup uses an 8-second network timeout. The policy uses a 20-second deadline for accepting lookup results: it blocks if the deadline has expired before the final approval check, even if a late lookup would have answered allow. Lookup waits use the remaining budget, but parsing and thread scheduling can delay the return. A timed-out lookup may continue in the background; its late result cannot authorize signing.

### What is sent, and limits

- Each offered payee address and its network go to `https://oceanalt.com/api/decide`. Nothing else from the request is sent.
- No key is needed. The free tier has a monthly anonymous allowance and per-IP rate limits, so agents behind one shared IP share them. When either is used up the policy blocks.

Verified with bedrock-agentcore 1.26.0 (strands-agents 1.64.0, langchain 1.4.10, langgraph 1.2.20) using a mock signer: no signer call on decline, review, unreadable, ambiguous or MPP input, timeout, exception, or an allow that arrives after the budget; one on allow. Not yet tested end to end in a live AWS account.

## Optional: the checks as agent tools

In the AgentCore console, open your Gateway, add a target of type MCP server and enter `https://oceanalt.com/api/mcp`. The outbound connection from your Gateway to OceanAlt needs no authorization; keep inbound authorization on your own Gateway as it is. The agent can then call `payment_decision`, `screen_endpoint` or `check_payment_request`. This lets the agent ask; it does not stop a payment. Use `pre_sign_policy` above to block signing.

## Notes

- A result with no risk signals is not a guarantee of safety.
- OceanAlt screens mainnets. Requests specifying testnet or unsupported networks are not cleared by this policy.
- Docs: https://oceanalt.com/en/api-docs
