/**
 * OpenAPI 3.0 description of the tools SentinelPay exposes to an EXTERNAL agent
 * (e.g. an agent built in Google's Agent Studio / Gemini Enterprise). Only two operations:
 * a shopping agent may ask "is this cart allowed?" and "what are my limits?".
 * Compiling/activating policies and capturing payments are deliberately NOT exposed.
 * Auth: Bearer <agent key>; the tenant is derived from the key.
 */
export function buildOpenApi(serverUrl: string) {
  const money = { type: "integer", minimum: 0, description: "Integer minor units (cents). Never decimals." };
  return {
    openapi: "3.0.3",
    info: {
      title: "SentinelPay agent tools",
      version: "1.0.0",
      description:
        "Deterministic spending guardrails for agentic checkout. Call validateCart BEFORE paying. " +
        "Treat DENY and REQUIRE_REAUTH as final: do not retry with altered numbers, and ask the human to re-authorize.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/validate-cart": {
        post: {
          operationId: "validateCart",
          summary: "Check a cart against the shopper's active spending policy",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["policyId", "cart"], properties: { policyId: { type: "string", format: "uuid" }, cart: { $ref: "#/components/schemas/Cart" } } } } },
          },
          responses: {
            "200": { description: "Decision", content: { "application/json": { schema: { $ref: "#/components/schemas/Evaluation" } } } },
            "403": { description: "Policy not active / not yours (decision is DENY)" },
            "429": { description: "Rate limited; honour Retry-After" },
            "503": { description: "Service error. Treat as DENY. Never proceed to payment." },
          },
        },
      },
      "/api/agent/policies/{id}": {
        get: {
          operationId: "getPolicy",
          summary: "Plain-language limits of a policy",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "Policy readback", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["draft", "active", "revoked"] }, rules: { type: "array", items: { type: "string" } } } } } } },
            "404": { description: "Not found" },
          },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "SentinelPay agent API key (sp_agt_…)" } },
      schemas: {
        Cart: {
          type: "object",
          required: ["cartId", "merchantId", "currency", "lines", "tax", "shipping", "total"],
          properties: {
            cartId: { type: "string" },
            merchantId: { type: "string", description: "PayPal merchant id registered to your tenant" },
            currency: { type: "string", pattern: "^[A-Z]{3}$" },
            lines: {
              type: "array", minItems: 1,
              items: {
                type: "object", required: ["sku", "quantity", "unitPrice"],
                properties: {
                  sku: { type: "string" }, quantity: { type: "integer", minimum: 1 }, unitPrice: money,
                  baselineUnitPrice: { ...money, nullable: true }, baselineFetchedAt: { type: "string", format: "date-time", nullable: true },
                },
              },
            },
            tax: money, shipping: money,
            total: { ...money, description: "Must equal sum(lines) + tax + shipping or the cart is DENIED." },
          },
        },
        Evaluation: {
          type: "object", required: ["decision", "violations"],
          properties: {
            decision: { type: "string", enum: ["ALLOW", "REQUIRE_REAUTH", "DENY"] },
            violations: { type: "array", items: { type: "object", properties: { rule: { type: "string" }, code: { type: "string" }, message: { type: "string" } } } },
          },
        },
      },
    },
  };
}
