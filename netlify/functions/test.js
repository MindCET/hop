// netlify/functions/test.js
exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify({
      message: 'Hello from Netlify!',
      method: event.httpMethod,
      hasApiKey: !!process.env.GEMINI_API_KEY,
      timestamp: new Date().toISOString(),
      body: event.body ? JSON.parse(event.body) : null
    })
  };
};
