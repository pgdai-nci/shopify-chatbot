export const config = { runtime: "edge" };

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const MAX_TOOL_ROUNDS = 3;

const SYSTEM_INSTRUCTION = `You are ShopiBot, a friendly and helpful shopping assistant for Shopi, an online store.

Your capabilities:
- Help customers find products by describing what they need
- Answer questions about products (sizes, materials, features)
- Check order status and tracking information
- Cancel unfulfilled orders
- Update shipping addresses on unfulfilled orders
- Provide product recommendations based on order history
- Guide customers through returns and exchanges

Customer verification rules:
- Before accessing any order information or making changes, you MUST verify the customer using their email and order number
- Never share order details without verification
- After verification, the session is valid for the conversation

Response guidelines:
- Friendly and approachable, but professional
- Concise — keep responses under 3 sentences unless more detail is needed
- Use emojis sparingly (1-2 per message max)

When a customer asks about their order, always ask for their email and order number first to verify them.`;

const TOOLS = [
  {
    name: "verify_customer",
    description: "Verifies a customer by email and order number. Call this before any order operations.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer's email address" },
        order_number: { type: "string", description: "Order number (e.g. '1001', without # prefix)" }
      },
      required: ["email", "order_number"]
    }
  },
  {
    name: "get_order_status",
    description: "Gets detailed status of an order including tracking info, items, and shipping status.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Shopify order ID (gid://shopify/Order/...)" }
      },
      required: ["order_id"]
    }
  },
  {
    name: "cancel_order",
    description: "Cancels an unfulfilled order. Use only after verifying the customer.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Shopify order ID" },
        reason: { type: "string", enum: ["customer_request", "fraud", "inventory", "other"], description: "Reason for cancellation" }
      },
      required: ["order_id"]
    }
  },
  {
    name: "update_shipping_address",
    description: "Updates shipping address for an unfulfilled order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Shopify order ID" },
        address: {
          type: "object",
          properties: {
            address1: { type: "string" },
            address2: { type: "string" },
            city: { type: "string" },
            province: { type: "string" },
            zip: { type: "string" },
            country: { type: "string" }
          },
          required: ["address1", "city", "zip", "country"]
        }
      },
      required: ["order_id", "address"]
    }
  },
  {
    name: "search_products",
    description: "Searches the product catalog by keyword.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        first: { type: "integer", description: "Number of results (default 5)" }
      },
      required: ["query"]
    }
  },
  {
    name: "get_customer_orders",
    description: "Gets a customer's order history by email.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer email" },
        first: { type: "integer", description: "Number of orders (default 5)" }
      },
      required: ["email"]
    }
  }
];

async function shopifyQuery(query, variables = {}) {
  const response = await fetch(`https://${SHOP_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ACCESS_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join(', '));
  return data.data;
}

function stripSensitive(order) {
  if (!order) return order;
  const s = { ...order };
  delete s.shippingAddress;
  delete s.billingAddress;
  if (s.lineItems?.edges) {
    s.lineItems = s.lineItems.edges.map(e => ({ title: e.node.title, quantity: e.node.quantity, price: e.node.variant?.price?.amount }));
  }
  return s;
}

async function executeTool(name, args) {
  switch (name) {
    case "verify_customer": {
      const data = await shopifyQuery(`query($email: String!) {
        customerByEmail(email: $email) {
          id firstName lastName email
          orders(first: 10) { edges { node { id name orderNumber financialStatus fulfillmentStatus createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 10) { edges { node { title quantity variant { title price { amount } } } } }
          } }
        }
      }`, { email: args.email });
      if (!data.customerByEmail) return { verified: false, error: "No customer found with that email" };
      const order = data.customerByEmail.orders.edges.find(e => e.node.orderNumber.toString() === args.order_number);
      if (!order) return { verified: false, error: "No order found with that number for this email" };
      return { verified: true, customer: { id: data.customerByEmail.id, name: `${data.customerByEmail.firstName} ${data.customerByEmail.lastName}` }, order: stripSensitive(order.node) };
    }
    case "get_order_status": {
      const data = await shopifyQuery(`query($id: ID!) {
        orderById(id: $id) {
          id name orderNumber cancelledAt cancelReason financialStatus fulfillmentStatus createdAt updatedAt
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 10) { edges { node { title quantity variant { title price { amount } } } } }
          fulfillments { trackingCompany trackingNumbers trackingUrl estimatedDeliveryAt status }
        }
      }`, { id: args.order_id });
      return stripSensitive(data.orderById);
    }
    case "cancel_order": {
      const status = await shopifyQuery(`query($id: ID!) { orderById(id: $id) { fulfillmentStatus cancelledAt } }`, { id: args.order_id });
      if (status.orderById.cancelledAt) return { error: "Order is already cancelled" };
      if (status.orderById.fulfillmentStatus === "FULFILLED") return { error: "Cannot cancel - order already fulfilled" };
      const data = await shopifyQuery(`mutation($id: ID!, $reason: OrderCancelReason!) {
        orderCancel(id: $id, reason: $reason, refund: true, restock: true) {
          order { id cancelledAt cancelReason financialStatus }
          userErrors { field message }
        }
      }`, { id: args.order_id, reason: args.reason || "customer_request" });
      if (data.orderCancel.userErrors.length > 0) return { error: data.orderCancel.userErrors.map(e => e.message).join(", ") };
      return { success: true, order: stripSensitive(data.orderCancel.order) };
    }
    case "update_shipping_address": {
      const status = await shopifyQuery(`query($id: ID!) { orderById(id: $id) { fulfillmentStatus cancelledAt } }`, { id: args.order_id });
      if (status.orderById.cancelledAt) return { error: "Cannot update - order is cancelled" };
      if (status.orderById.fulfillmentStatus === "FULFILLED") return { error: "Cannot update - order already fulfilled" };
      const data = await shopifyQuery(`mutation($order_id: ID!, $address: MailingAddressInput!) {
        orderUpdateShippingAddress(orderId: $order_id, shippingAddress: $address) {
          order { id shippingAddress { address1 city province zip country } }
          userErrors { field message }
        }
      }`, { order_id: args.order_id, address: args.address });
      if (data.orderUpdateShippingAddress.userErrors.length > 0) return { error: data.orderUpdateShippingAddress.userErrors.map(e => e.message).join(", ") };
      return { success: true, address: data.orderUpdateShippingAddress.order.shippingAddress };
    }
    case "search_products": {
      const data = await shopifyQuery(`query($query: String!, $first: Int!) {
        products(first: $first, query: $query) {
          edges { node { id title handle productType
            priceRange { minVariantPrice { amount currencyCode } }
            images(first: 1) { edges { node { url altText } } }
            variants(first: 5) { edges { node { title price { amount } inventoryQuantity } } }
          } }
        }
      }`, { query: args.query, first: args.first || 5 });
      return data.products.edges.map(e => ({
        id: e.node.id, title: e.node.title, handle: e.node.handle, type: e.node.productType,
        price: e.node.priceRange.minVariantPrice.amount, currency: e.node.priceRange.minVariantPrice.currencyCode,
        imageUrl: e.node.images.edges[0]?.node.url,
        variants: e.node.variants.edges.map(v => ({ title: v.node.title, price: v.node.price.amount, inventory: v.node.inventoryQuantity }))
      }));
    }
    case "get_customer_orders": {
      const data = await shopifyQuery(`query($email: String!, $first: Int!) {
        customerByEmail(email: $email) {
          id firstName lastName email
          orders(first: $first) { edges { node { id name orderNumber financialStatus fulfillmentStatus createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 5) { edges { node { title quantity } } }
          } } }
        }
      }`, { email: args.email, first: args.first || 5 });
      if (!data.customerByEmail) return { error: "No customer found with that email" };
      return { customer: { name: `${data.customerByEmail.firstName} ${data.customerByEmail.lastName}` }, orders: data.customerByEmail.orders.edges.map(e => stripSensitive(e.node)) };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function callGemini(contents, tools, systemInstruction) {
  const body = { contents };
  if (tools) body.tools = [{ functionDeclarations: tools }];
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };

  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  return response.json();
}

export default async function handler(req) {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { code: 405, message: "Method not allowed" } }), { status: 405, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }

  try {
    const body = await req.json();
    if (!body.contents || !Array.isArray(body.contents)) {
      return new Response(JSON.stringify({ error: { code: 400, message: "Missing contents" } }), { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
    }

    let contents = [...body.contents];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const geminiResponse = await callGemini(contents, TOOLS, SYSTEM_INSTRUCTION);
      const candidate = geminiResponse.candidates?.[0];

      if (!candidate?.content?.parts?.length) {
        return new Response(JSON.stringify({ text: "I'm sorry, I couldn't generate a response." }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      const functionCalls = candidate.content.parts.filter(p => p.functionCall);

      if (functionCalls.length === 0) {
        const text = candidate.content.parts.filter(p => p.text).map(p => p.text).join("");
        return new Response(JSON.stringify({ text }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
      }

      contents.push(candidate.content);

      for (const fc of functionCalls) {
        const { name, args } = fc.functionCall;
        let result;
        try { result = await executeTool(name, args); } catch (e) { result = { error: e.message }; }
        contents.push({ role: "user", parts: [{ functionResponse: { name, response: result } }] });
      }
    }

    const finalResponse = await callGemini(contents, null, SYSTEM_INSTRUCTION);
    const text = finalResponse.candidates?.[0]?.content?.parts?.map(p => p.text)?.join("") || "I'm sorry, I couldn't process your request.";
    return new Response(JSON.stringify({ text }), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });

  } catch (error) {
    return new Response(JSON.stringify({ error: { code: 500, message: "Internal server error" } }), { status: 500, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  }
}
