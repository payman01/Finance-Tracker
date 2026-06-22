const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'userdata';
const PARTITION  = 'u'; // single partition — all users in one table

let tableClient = null;

async function getClient() {
  if (tableClient) return tableClient;
  tableClient = TableClient.fromConnectionString(
    process.env.STORAGE_CONNECTION_STRING,
    TABLE_NAME
  );
  try {
    await tableClient.createTable();
  } catch (e) {
    if (e.statusCode !== 409) throw e; // 409 = already exists, fine
  }
  return tableClient;
}

function getUserId(req) {
  const header = req.headers['x-ms-client-principal'];
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const principal = JSON.parse(decoded);
    const email = (principal.userDetails || '').toLowerCase();
    if (!email.endsWith('@officemasters.ca')) return null;
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
    const client = await getClient();

    if (req.method === 'GET') {
      try {
        const entity = await client.getEntity(PARTITION, userId);
        context.res = {
          status: 200,
          headers: HEADERS,
          body: JSON.stringify({ store: JSON.parse(entity.store), updatedAt: entity.updatedAt })
        };
      } catch (e) {
        if (e.statusCode === 404) {
          context.res = { status: 200, headers: HEADERS, body: JSON.stringify(null) };
        } else {
          throw e;
        }
      }

    } else if (req.method === 'PUT') {
      const store = req.body && req.body.store;
      if (!store) {
        context.res = { status: 400, headers: HEADERS, body: JSON.stringify({ error: 'store required' }) };
        return;
      }
      const updatedAt = new Date().toISOString();
      await client.upsertEntity({
        partitionKey: PARTITION,
        rowKey: userId,
        store: JSON.stringify(store),
        updatedAt
      }, 'Replace');
      context.res = { status: 200, headers: HEADERS, body: JSON.stringify({ ok: true, updatedAt }) };
    }

  } catch (e) {
    context.log.error('Storage error:', e.message);
    context.res = { status: 500, headers: HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
