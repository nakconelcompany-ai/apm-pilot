const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { before, after, test } = require('node:test');

const root = path.resolve(__dirname, '..');
const adminHeaders = { 'x-admin-username': 'test-admin', authorization: 'Bearer test-password' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let directory;
let server;
let baseUrl;
let phoneSequence = 0;

before(async () => {
  // Run against disposable local storage with no production environment or credentials.
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apm-registration-test-'));
  await fs.copyFile(path.join(root, 'server.js'), path.join(directory, 'server.js'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  server = spawn(process.execPath, ['-e', `
    require('./server').listen(0, '127.0.0.1', function () {
      console.log('TEST_PORT=' + this.address().port);
    });
  `], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: 'test-password',
      ACCOUNT_ENCRYPTION_KEY: 'ab'.repeat(32)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error('Test server did not start: ' + errors)), 10000);
    server.stderr.on('data', chunk => { errors += chunk; });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => {
      clearTimeout(timer);
      reject(new Error('Test server exited: ' + code + ' ' + errors));
    });
    server.stdout.on('data', chunk => {
      output += chunk;
      const port = output.match(/TEST_PORT=(\d+)/);
      if (port) {
        clearTimeout(timer);
        baseUrl = 'http://127.0.0.1:' + port[1];
        resolve();
      }
    });
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function register({ status = 'no', image, fields = {} } = {}) {
  const form = new FormData();
  const values = {
    name: 'Registration Test', phone: '0800000' + String(++phoneSequence).padStart(4, '0'),
    email: 'registration@example.test', lga: 'Ibadan North', ...fields
  };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  if (status !== null) form.set('hasVoterCard', status);
  if (image) form.set('voterCardFile', new Blob([image], { type: 'image/png' }), 'card.png');
  const response = await fetch(baseUrl + '/api/register', { method: 'POST', body: form });
  return { response, body: await response.json(), values };
}

test('no-card registration persists an explicit no status and no file, and appears in admin/export', async () => {
  const result = await register();
  assert.equal(result.response.status, 201);
  assert.equal(result.body.success, true);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'data/registrations.json'), 'utf8'));
  const record = stored.find(item => item.id === result.body.id);
  assert.equal(record.hasVoterCard, 'no');
  assert.equal(record.voterCardFile, null);

  const listing = await fetch(baseUrl + '/api/admin/registrations', { headers: adminHeaders });
  const listed = (await listing.json()).data.find(item => item.id === record.id);
  assert.equal(listed.hasVoterCard, 'no');
  assert.equal(listed.voterCardFile, null);
  const csv = await (await fetch(baseUrl + '/api/admin/registrations/export', { headers: adminHeaders })).text();
  const row = csv.split('\n').find(line => line.includes(result.values.phone));
  assert.ok(row.endsWith(',"no",""'));
  const file = await fetch(baseUrl + '/api/admin/registrations/' + record.id + '/file', { headers: adminHeaders });
  assert.equal(file.status, 404);

  const duplicate = await register({ fields: { phone: result.values.phone } });
  assert.equal(duplicate.response.status, 409);
  const deleted = await fetch(baseUrl + '/api/admin/registrations/' + record.id, {
    method: 'DELETE', headers: adminHeaders
  });
  assert.equal(deleted.status, 200);
});

test('no-card registration accepts every optional field blank and exposes it in admin', async () => {
  const fields = { ward: '', unit: '', bankName: '', accountName: '', accountNumber: '' };
  const result = await register({ fields });
  assert.equal(result.response.status, 201);
  const stored = JSON.parse(await fs.readFile(path.join(directory, 'data/registrations.json'), 'utf8'));
  const record = stored.find(item => item.id === result.body.id);
  assert.equal(record.hasVoterCard, 'no');
  assert.equal(record.voterCardFile, null);
  assert.equal(record.accountNumberEncrypted, null);
  assert.equal(record.accountNumberLast4, '');
  for (const key of ['ward', 'unit', 'bankName', 'accountName']) assert.equal(record[key], '');

  const response = await fetch(baseUrl + '/api/admin/registrations/' + record.id, { headers: adminHeaders });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.hasVoterCard, 'no');
  assert.equal(data.voterCardFile, null);
  for (const key of Object.keys(fields)) assert.equal(data[key], '');
});

test('optional details supplied by a no-card registrant are saved and available in admin', async () => {
  const fields = {
    ward: 'Ward 4', unit: '012', bankName: 'Test Bank',
    accountName: 'Registration Test', accountNumber: '0123456789'
  };
  const result = await register({ fields });
  assert.equal(result.response.status, 201);
  const response = await fetch(baseUrl + '/api/admin/registrations/' + result.body.id, { headers: adminHeaders });
  const { data } = await response.json();
  assert.equal(data.hasVoterCard, 'no');
  assert.equal(data.voterCardFile, null);
  for (const [key, value] of Object.entries(fields)) assert.equal(data[key], value);

  const listing = await fetch(baseUrl + '/api/admin/registrations', { headers: adminHeaders });
  const listed = (await listing.json()).data.find(item => item.id === result.body.id);
  assert.equal(listed.unit, fields.unit);
  assert.equal(listed.accountNumberLast4, '6789');
  assert.equal(listed.accountNumber, undefined);
  assert.equal(listed.accountNumberEncrypted, undefined);
});

test('card holders can still register with a valid image', async () => {
  const result = await register({ status: 'yes', image: png });
  assert.equal(result.response.status, 201);
  const response = await fetch(baseUrl + '/api/admin/registrations/' + result.body.id, { headers: adminHeaders });
  const { data } = await response.json();
  assert.equal(data.hasVoterCard, 'yes');
  assert.equal(data.voterCardFile.originalName, 'card.png');
  const file = await fetch(baseUrl + '/api/admin/registrations/' + data.id + '/file', { headers: adminHeaders });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
});

test('card holders must still supply an image', async () => {
  const result = await register({ status: 'yes' });
  assert.equal(result.response.status, 400);
  assert.match(result.body.message, /scan or upload/i);
});

test('missing or invalid card status is rejected', async () => {
  for (const status of [null, '', 'maybe']) {
    const result = await register({ status });
    assert.equal(result.response.status, 400);
    assert.match(result.body.message, /choose whether/i);
  }
});

test('no-card status cannot be saved with a contradictory attachment', async () => {
  const uploads = path.join(directory, 'data/uploads');
  const beforeFiles = await fs.readdir(uploads);
  const result = await register({ status: 'no', image: png });
  assert.equal(result.response.status, 400);
  assert.match(result.body.message, /remove the card image/i);
  assert.deepEqual(await fs.readdir(uploads), beforeFiles);
});

test('invalid images are still rejected and cleaned up', async () => {
  const uploads = path.join(directory, 'data/uploads');
  const beforeFiles = await fs.readdir(uploads);
  const result = await register({ status: 'yes', image: Buffer.from('not an image') });
  assert.equal(result.response.status, 400);
  assert.match(result.body.message, /not a supported/i);
  assert.deepEqual(await fs.readdir(uploads), beforeFiles);
});

test('registration without a card still validates required contact details', async () => {
  for (const fields of [{ email: '' }, { email: 'invalid' }, { lga: '' }, { phone: 'invalid' }]) {
    const result = await register({ fields });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.success, false);
  }
});
