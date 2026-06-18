const { CosmosClient } = require('@azure/cosmos');

let container;

async function getContainer() {
  if (container) return container;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const { database } = await client.databases.createIfNotExists({ id: 'finance-tracker' });
  const { container: c } = await database.containers.createIfNotExists({
    id: 'user-data',
    partitionKey: { paths: ['/userId'] },
    defaultTtl: -1
  });
  container = c;
  return container;
}

function getUserId(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const principal = JSON.parse(decoded);
    return principal.userId || null;
  } catch { return null; }
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*'
};

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: HEADERS };
    return;
  }

  const userId = getUserId(req);
  if (!userId) {
    context.res = { status: 401, headers: HEADERS, body: JSON.stringify({ error: 'Not authenticated' }) };
    return;
  }

  try {
    const c = await getContainer();

    if (req.method === 'GET') {
      try {
        const { resource } = await c.item(userId, userId).read();
        context.res = {
          status: 200,
          headers: HEADERS,
          body: JSON.stringify(resource ? { store: resource.store, updatedAt: resource.updatedAt } : null)
        };
      } catch (e) {
        context.res = {
          status: e.code === 404 ? 200 : 500,
          headers: HEADERS,
          body: e.code === 404 ? JSON.stringify(null) : JSON.stringify({ error: e.message })
        };
      }

    } else if (req.method === 'PUT') {
      const store = req.body && req.body.store;
      if (!store) {
        context.res = { status: 400, headers: HEADERS, body: JSON.stringify({ error: 'store required' }) };
        return;
      }
      const doc = { id: userId, userId, store, updatedAt: new Date().toISOString() };
      await c.items.upsert(doc);
      context.res = { status: 200, headers: HEADERS, body: JSON.stringify({ ok: true, updatedAt: doc.updatedAt }) };
    }

  } catch (e) {
    context.log.error('Error:', e.message);
    context.res = { status: 500, headers: HEADERS, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
