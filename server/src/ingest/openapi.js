// OpenAPI 3 definition of the client order API and the internal ingest endpoints.

const Issue = {
  type: 'object',
  properties: {
    code: { type: 'string', example: 'zip_state_mismatch' },
    severity: { type: 'string', enum: ['fatal', 'error', 'warning'] },
    field: { type: 'string', nullable: true, example: 'ship_to.zip' },
    message: { type: 'string', example: 'ZIP 94105 is not a CT ZIP code' },
    suggestion: { type: 'string', example: 'ZIP 94105 belongs to AK/CA/HI/OR/WA; CT ZIPs start with 0' },
  },
};

const OrderIn = {
  type: 'object',
  required: ['client_order_ref', 'sku', 'quantity', 'ship_to'],
  properties: {
    client_order_ref: { type: 'string', description: 'Your PO number; used for duplicate detection', example: 'PO-88213' },
    sku: { type: 'string', example: 'HX-2201' },
    quantity: { type: 'integer', minimum: 1, example: 40 },
    service: { type: 'string', description: 'same_day | next_day | standard (synonyms like "overnight" are accepted)', example: 'next_day' },
    requested_date: { type: 'string', format: 'date', example: '2026-10-29' },
    received_at: { type: 'string', format: 'date-time', description: 'Defaults to the time Halcyon receives the request', example: '2026-10-27T07:15' },
    ship_to: {
      type: 'object',
      required: ['name', 'street', 'city', 'state', 'zip'],
      properties: {
        name: { type: 'string', example: 'Dana Ortiz' },
        street: { type: 'string', example: '418 Harbor Street' },
        city: { type: 'string', example: 'Hartford' },
        state: { type: 'string', description: 'Two-letter code or full name', example: 'CT' },
        zip: { type: 'string', example: '06103' },
      },
    },
  },
};

const OrderResult = {
  type: 'object',
  properties: {
    ref: { type: 'string', example: 'IN-000042' },
    line: { type: 'string', example: 'orders[0]' },
    client_order_ref: { type: 'string' },
    status: { type: 'string', enum: ['accepted', 'corrected', 'held', 'rejected', 'duplicate'] },
    promised_date: { type: 'string', format: 'date', nullable: true },
    commitment_type: { type: 'string' },
    carrier_id: { type: 'string', nullable: true },
    late_risk: { type: 'number', nullable: true, description: 'AI-predicted probability of late delivery', example: 0.06 },
    risk_drivers: { type: 'array', items: { type: 'object', properties: { feature: { type: 'string' }, impact: { type: 'number' } } } },
    corrections: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, from: {}, to: {}, rule: { type: 'string' } } } },
    issues: { type: 'array', items: { $ref: '#/components/schemas/Issue' } },
  },
};

const Error = { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } };
const json = (schema) => ({ content: { 'application/json': { schema } } });
const err = (description) => ({ description, ...json({ $ref: '#/components/schemas/Error' }) });

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Halcyon Logistics — Order Intake API',
    version: '1.0.0',
    description: 'Submit delivery orders. Every order is normalised, validated and scored by the AI risk model before it reaches '
      + 'the warehouse. Statuses: accepted, corrected (accepted after automatic fixes), held (you must correct it), rejected, duplicate.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: { OrderIn, OrderResult, Issue, Error },
  },
  paths: {
    '/auth/login': {
      post: {
        tags: ['Authentication'], summary: 'Exchange client credentials for a bearer token (valid 1 hour)',
        requestBody: { required: true, ...json({ type: 'object', required: ['client_id', 'client_secret'], properties: { client_id: { type: 'string', example: 'C055' }, client_secret: { type: 'string' } } }) },
        responses: {
          200: { description: 'Token', ...json({ type: 'object', properties: { access_token: { type: 'string' }, token_type: { type: 'string', example: 'Bearer' }, expires_in: { type: 'integer', example: 3600 } } }) },
          401: err('Wrong credentials'),
        },
      },
    },
    '/v1/orders': {
      post: {
        tags: ['Orders'], summary: 'Submit one order or a batch', security: [{ bearer: [] }],
        parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Retries with the same key return the first response' }],
        requestBody: { required: true, ...json({ oneOf: [{ $ref: '#/components/schemas/OrderIn' }, { type: 'object', properties: { orders: { type: 'array', maxItems: 500, items: { $ref: '#/components/schemas/OrderIn' } } } }] }) },
        responses: {
          200: { description: 'Per-order outcome', ...json({ type: 'object', properties: { message_id: { type: 'integer' }, status: { type: 'string' }, summary: { type: 'object' }, orders: { type: 'array', items: { $ref: '#/components/schemas/OrderResult' } } } }) },
          400: err('Payload is not an order or a batch'), 401: err('Missing or expired token'),
          403: err('Order names a different client'), 413: err('More than 500 orders'),
        },
      },
      get: {
        tags: ['Orders'], summary: 'Your recent orders', security: [{ bearer: [] }],
        responses: { 200: { description: 'Orders', ...json({ type: 'array', items: { $ref: '#/components/schemas/OrderResult' } }) }, 401: err('Unauthorised') },
      },
    },
    '/v1/orders/{ref}': {
      parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string', example: 'IN-000042' } }],
      get: { tags: ['Orders'], summary: 'Order status', security: [{ bearer: [] }], responses: { 200: { description: 'Order', ...json({ $ref: '#/components/schemas/OrderResult' }) }, 404: err('Not your order') } },
      patch: {
        tags: ['Orders'], summary: 'Correct a held order; it is re-validated and released if clean', security: [{ bearer: [] }],
        requestBody: { required: true, ...json({ type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' }, service: { type: 'string' }, ship_to: OrderIn.properties.ship_to } }) },
        responses: { 200: { description: 'Re-processed order', ...json({ $ref: '#/components/schemas/OrderResult' }) }, 404: err('Not your order'), 409: err('Order can no longer be changed') },
      },
    },
    '/ingest/email': {
      post: {
        tags: ['Internal channels'], summary: 'Process a raw email (.eml) — body text and CSV attachments',
        requestBody: { content: { 'message/rfc822': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } } } } } },
        responses: { 200: { description: 'Outcome plus the reply drafted to the sender' } },
      },
    },
    '/ingest/email/inbound': {
      post: {
        tags: ['Internal channels'], summary: 'Email-provider inbound webhook (pre-parsed email)',
        requestBody: { ...json({ type: 'object', required: ['from'], properties: { from: { type: 'string' }, subject: { type: 'string' }, date: { type: 'string' }, text: { type: 'string' }, attachments: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } } } } } }) },
        responses: { 200: { description: 'Outcome plus reply' } },
      },
    },
    '/ingest/edi': {
      post: {
        tags: ['Internal channels'], summary: 'Process an ANSI X12 850 file; returns a 997 acknowledgement',
        requestBody: { content: { 'application/edi-x12': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } } } } } },
        responses: { 200: { description: 'Outcome plus 997' } },
      },
    },
    '/ingest/messages': { get: { tags: ['Monitoring'], summary: 'Inbound messages', responses: { 200: { description: 'List' } } } },
    '/ingest/stats': { get: { tags: ['Monitoring'], summary: 'Outcomes by channel, issue and correction', responses: { 200: { description: 'Stats' } } } },
  },
};

export const docsPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Halcyon Order Intake API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
<style>body{margin:0;background:#fff}</style></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#ui', persistAuthorization: true, tryItOutEnabled: true });</script>
</body></html>`;
