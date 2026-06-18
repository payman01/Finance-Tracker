const { CosmosClient } = require('@azure/cosmos');

let container;

async function getContainer() {
  if (container) return container;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const { database } = await client.databases.createIfNotExists({ id: 'finance-tracker' });
  const { container: c } = await database.containers.createIfNotExists({
    id: 'user-data',
    partitionKey: { paths: ['/syncId'] },
    defaultTtl: -1  // no TTL — data kept indefinitely
  });
  container = c;
  return container;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers: corsHeaders() };
    return;
  }

  const syncId = req.query.syncId || (req.body && req.body.syncId);

  if (!syncId || syncId.length < 8) {
    context.res = { status: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'syncId required' }) };
    return;
  }

  try {
    const c = await getContainer();

    if (req.method === 'GET') {
      try {
        const { resource } = await c.item(syncId, syncId).read();
        context.res = {
          status: 200,
          headers: corsHeaders(),
          body: JSON.stringify(resource ? { store: resource.store, updatedAt: resource.updatedAt } : null)
        };
      } catch (e) {
        if (e.code === 404) {
          context.res = { status: 200, headers: corsHeaders(), body: JSON.stringify(null) };
        } else {
          throw e;
        }
      }

    } else if (req.method === 'PUT') {
      const store = req.body && req.body.store;
      if (!store) {
        context.res = { status: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'store required' }) };
        return;
      }
      const doc = {
        id: syncId,
        syncId,
        store,
        updatedAt: new Date().toISOString()
      };
      await c.items.upsert(doc);
      context.res = { status: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, updatedAt: doc.updatedAt }) };
    }

  } catch (e) {
    context.log.error('Cosmos error:', e.message);
    context.res = { status: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Internal error' }) };
  }
};
