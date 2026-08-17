export const config = { runtime: "edge" };

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const AFTERSHIP_API_KEY = process.env.AFTERSHIP_API_KEY;
const AFTERSHIP_URL = "https://api.aftership.com/tracking/2026-07/trackings";
const MAX_TOOL_ROUNDS = 5;

const SYSTEM_INSTRUCTION = `You are ShopiBot, a friendly and helpful shopping assistant for Shopi, an online store.

Your capabilities:
- Help customers find products by describing what they need
- Answer questions about products (sizes, materials, features)
- Check order status and tracking information
- Cancel unfulfilled orders
- Update shipping addresses on unfulfilled orders
- Provide product recommendations based on order history
- Guide customers through returns and exchanges
- Track courier/package status using AfterShip (label created, in transit, out for delivery, delivered, etc.)

Customer verification rules:
- Before accessing any order information or making changes, you MUST verify the customer using their email and order number
- Never share order details without verification
- After verification, the session is valid for the conversation

When a customer asks to track a package:
- If they provide a tracking number directly, use track_package
- If they ask about tracking for their order, use get_tracking_by_order (requires verification first)
- You can track multiple packages for an order

Response guidelines:
- Friendly and approachable, but professional
- Concise — keep responses under 3 sentences unless more detail is needed
- Use emojis sparingly (1-2 per message max)
- When sharing tracking status, include carrier name, current status, and estimated delivery if available

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
  },
  {
    name: "track_package",
    description: "Gets detailed tracking information for a package by its tracking number. Returns carrier name, current status, estimated delivery date, and recent checkpoint history. Use when customer provides a tracking number directly.",
    parameters: {
      type: "object",
      properties: {
        tracking_number: { type: "string", description: "The tracking number (e.g. '1Z999AA10123456784')" }
      },
      required: ["tracking_number"]
    }
  },
  {
    name: "get_tracking_by_order",
    description: "Gets tracking information for all packages in an order by looking up fulfillment tracking numbers from Shopify, then enriching with AfterShip data. Requires verified order.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Shopify order ID (gid://shopify/Order/...)" }
      },
      required: ["order_id"]
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

async function aftershipTrack(trackingNumbers) {
  const nums = Array.isArray(trackingNumbers) ? trackingNumbers : [trackingNumbers];
  const url = `${AFTERSHIP_URL}?tracking_numbers=${nums.join(",")}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "as-api-key": AFTERSHIP_API_KEY, "Content-Type": "application/json" }
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AfterShip API error: ${response.status} - ${err}`);
  }
  return response.json();
}

function formatAfterShipTracking(t) {
  return {
    tracking_number: t.tracking_number,
    carrier: t.slug,
    status: t.tag,
    status_detail: t.subtag,
    estimated_delivery: t.aftership_estimated_delivery_date,
    checkpoints: (t.checkpoints || []).slice(-3).map(c => ({
      location: `${c.location || ""}`.trim() || "Unknown",
      status: c.tag,
      timestamp: c.checkpoint_time,
      message: c.message
    }))
  };
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
      const custData = await shopifyQuery(`query($email: String!) {
        customers(first: 5, query: $email) {
          edges { node { id firstName lastName email } }
        }
      }`, { email: `email:${args.email}` });
      if (!custData.customers?.edges?.length) return { verified: false, error: "No customer found with that email" };
      const customer = custData.customers.edges[0].node;
      const ordersData = await shopifyQuery(`query($email: String!) {
        orders(first: 10, query: $email) {
          edges { node { id name displayFinancialStatus displayFulfillmentStatus createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 10) { edges { node { title quantity } } }
          } }
        }
      }`, { email: `email:${args.email}` });
      const orderNum = args.order_number.replace(/^#/, "");
      const order = ordersData.orders.edges.find(e => {
        const orderName = e.node.name.replace(/^#/, "");
        return orderName === orderNum;
      });
      if (!order) return { verified: false, error: "No order found with that number for this email" };
      return { verified: true, customer: { id: customer.id, name: `${customer.firstName} ${customer.lastName}` }, order: stripSensitive(order.node) };
    }
    case "get_order_status": {
      const data = await shopifyQuery(`query($id: ID!) {
        orderById(id: $id) {
          id name cancelledAt cancelReason displayFinancialStatus displayFulfillmentStatus createdAt updatedAt
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 10) { edges { node { title quantity variant { title price { amount } } } } }
          fulfillments { status updatedAt trackingInfo { company number url } estimatedDeliveryAt }
        }
      }`, { id: args.order_id });
      return stripSensitive(data.orderById);
    }
    case "cancel_order": {
      const status = await shopifyQuery(`query($id: ID!) { orderById(id: $id) { displayFulfillmentStatus cancelledAt } }`, { id: args.order_id });
      if (status.orderById.cancelledAt) return { error: "Order is already cancelled" };
      if (status.orderById.displayFulfillmentStatus === "FULFILLED") return { error: "Cannot cancel - order already fulfilled" };
      const data = await shopifyQuery(`mutation($id: ID!, $reason: OrderCancelReason!) {
        orderCancel(id: $id, reason: $reason, refund: true, restock: true) {
          order { id cancelledAt cancelReason displayFinancialStatus }
          userErrors { field message }
        }
      }`, { id: args.order_id, reason: args.reason || "customer_request" });
      if (data.orderCancel.userErrors.length > 0) return { error: data.orderCancel.userErrors.map(e => e.message).join(", ") };
      return { success: true, order: stripSensitive(data.orderCancel.order) };
    }
    case "update_shipping_address": {
      const status = await shopifyQuery(`query($id: ID!) { orderById(id: $id) { displayFulfillmentStatus cancelledAt } }`, { id: args.order_id });
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
        orders(first: $first, query: $email) {
          edges { node { id name displayFinancialStatus displayFulfillmentStatus createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 5) { edges { node { title quantity } } }
          } }
        }
      }`, { email: `email:${args.email}`, first: args.first || 5 });
      if (!data.orders?.edges?.length) return { error: "No orders found for that email" };
      return { orders: data.orders.edges.map(e => stripSensitive(e.node)) };
    }
    case "track_package": {
      const data = await aftershipTrack(args.tracking_number);
      if (!data.data?.trackings?.length) return { error: "No tracking found for that number" };
      return formatAfterShipTracking(data.data.trackings[0]);
    }
    case "get_tracking_by_order": {
      const orderData = await shopifyQuery(`query($id: ID!) {
        orderById(id: $id) {
          id name displayFulfillmentStatus
          fulfillments { status updatedAt trackingInfo { company number url } estimatedDeliveryAt }
        }
      }`, { id: args.order_id });
      const order = orderData.orderById;
      if (!order) return { error: "Order not found" };
      const allTrackingNums = (order.fulfillments || []).map(f => f.trackingInfo?.number).filter(Boolean);
      if (allTrackingNums.length === 0) return { error: "No tracking information available yet for this order. The order status is: " + (order.displayFulfillmentStatus || "unfulfilled") };
      const aftershipData = await aftershipTrack(allTrackingNums);
      const enriched = aftershipData.data?.trackings || [];
      return {
        order: { name: order.name, status: order.displayFulfillmentStatus },
        packages: enriched.map(formatAfterShipTracking)
      };
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
        console.log(`Tool ${name} result:`, JSON.stringify(result).slice(0, 500));
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
