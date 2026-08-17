const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: { code: 405, message: 'Method not allowed' } }),
        { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }

    try {
      const body = await request.json();

      if (!body.contents || !Array.isArray(body.contents)) {
        return new Response(
          JSON.stringify({ error: { code: 400, message: 'Missing or invalid contents array' } }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      const geminiBody = { contents: body.contents };

      if (body.systemInstruction) {
        geminiBody.systemInstruction = body.systemInstruction;
      }

      if (body.generationConfig) {
        geminiBody.generationConfig = body.generationConfig;
      }

      const geminiResponse = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': env.GEMINI_API_KEY,
          },
          body: JSON.stringify(geminiBody),
        }
      );

      const data = await geminiResponse.text();

      return new Response(data, {
        status: geminiResponse.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: { code: 500, message: 'Internal worker error' } }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }
  },
};
