import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../../src/client.js';
import { silentLogger } from '../../src/core/logger.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { mapZohoInvoiceStatus, skydo, type SkydoCredentials } from '../../src/providers/skydo/adapter.js';
import { parseReceivingAccounts } from '../../src/providers/skydo/accounts.js';
import { fakeFetch, testContext, type FakeRoute } from '../helpers.js';

const ACCOUNTS = JSON.stringify([
  { currency: 'USD', label: 'US account (ACH)', details: { 'Account holder': 'Acme Exports', 'Account number': '1234567890', 'ACH routing': '026073150' } },
  { currency: 'GBP', details: { 'Account holder': 'Acme Exports', 'Sort code': '04-00-75', 'Account number': '12345678' } },
]);

const tempLedger = () => join(mkdtempSync(join(tmpdir(), 'skydo-')), 'ledger.json');

function ledgerGateway(extra: Partial<SkydoCredentials> = {}, routes: FakeRoute[] = []) {
  const f = fakeFetch(routes);
  const gw = skydo.create({ receivingAccounts: ACCOUNTS, payeeName: 'Acme Exports', ledgerFile: tempLedger(), ...extra }, testContext('skydo', f.fetch));
  return { gw: gw as ReturnType<typeof skydo.create> & { recordPayment: Function; outstanding: Function }, ...f };
}

const ZOHO: SkydoCredentials = {
  zohoDataCenter: 'in',
  zohoClientId: '1000.CLIENT',
  zohoClientSecret: 'zsecret',
  zohoRefreshToken: '1000.refresh',
  zohoOrganizationId: '60012345',
  zohoItemId: '4600000000001',
};

const TOKEN: FakeRoute = { match: 'POST https://accounts.zoho.in/oauth/v2/token', body: { access_token: '1000.access', api_domain: 'https://www.zohoapis.in', token_type: 'Bearer', expires_in: 3600 } };
const invoice = (over: Record<string, unknown> = {}) => ({
  invoice_id: '460000000099',
  invoice_number: 'INV-000042',
  reference_number: 'ord_skydo_1',
  status: 'draft',
  customer_id: '460000000011',
  currency_code: 'USD',
  total: 1200,
  balance: 1200,
  payment_made: 0,
  write_off_amount: 0,
  has_attachment: false,
  invoice_url: 'https://books.zoho.in/SecurePayment?CInvoiceID=abc',
  ...over,
});

function zohoGateway(routes: FakeRoute[], extra: Partial<SkydoCredentials> = {}) {
  const f = fakeFetch([TOKEN, ...routes]);
  const gw = skydo.create({ ...ZOHO, ledgerFile: tempLedger(), ...extra }, testContext('skydo', f.fetch, { extractError: skydo.extractError }));
  return { gw, ...f };
}

describe('skydo configuration', () => {
  it('requires receiving accounts or the Zoho bridge, and explains how', () => {
    const f = fakeFetch([]);
    expect(() => skydo.create({}, testContext('skydo', f.fetch))).toThrow(/SKYDO_RECEIVING_ACCOUNTS/);
  });

  it('names every missing variable when the Zoho bridge is half-configured', () => {
    const f = fakeFetch([]);
    expect(() => skydo.create({ zohoClientId: 'x', zohoClientSecret: 'y' }, testContext('skydo', f.fetch))).toThrow(
      /ZOHO_DATA_CENTER, ZOHO_REFRESH_TOKEN, ZOHO_ORGANIZATION_ID, ZOHO_ITEM_ID/,
    );
  });

  it('rejects an unknown Zoho data center', () => {
    const f = fakeFetch([]);
    expect(() => skydo.create({ ...ZOHO, zohoDataCenter: 'mars' }, testContext('skydo', f.fetch))).toThrow(/ZOHO_DATA_CENTER/);
  });

  it('validates receiving accounts JSON, inline or from a file', () => {
    expect(() => parseReceivingAccounts('[{"currency":"US","details":{"a":"b"}}]')).toThrow(/ISO code/);
    expect(() => parseReceivingAccounts('[{"currency":"USD","details":{}}]')).toThrow(/details/);
    expect(() => parseReceivingAccounts('[]')).toThrow(/non-empty/);
    expect(() => parseReceivingAccounts('[not json')).toThrow(/not valid JSON/);
    expect(() => parseReceivingAccounts('/no/such/file.json')).toThrow(/neither JSON nor an existing file/);
    const file = join(mkdtempSync(join(tmpdir(), 'skydo-acc-')), 'accounts.json');
    writeFileSync(file, ACCOUNTS);
    expect(parseReceivingAccounts(file).map((a) => a.currency)).toEqual(['USD', 'GBP']);
  });

  it('never makes a network call in ledger mode', async () => {
    const { gw, requests } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_net_1', amount: 100000, currency: 'USD' });
    await gw.getPaymentStatus({ orderRef: 'ord_net_1' });
    expect(requests).toHaveLength(0);
  });
});

describe('skydo ledger mode (receiving accounts)', () => {
  it('returns payment instructions with the account details and the orderRef as reference', async () => {
    const { gw } = ledgerGateway();
    const r = await gw.createPayment({ orderRef: 'ord_l_1', amount: 125050, currency: 'USD', customer: { name: 'Globex', email: 'ap@globex.com' }, description: 'Design retainer' });
    expect(r).toMatchObject({ provider: 'skydo', providerOrderId: 'skydo:ord_l_1', status: 'created', amount: 125050, currency: 'USD' });
    expect(r.checkout.type).toBe('manual');
    if (r.checkout.type !== 'manual') return;
    expect(r.checkout.instructions).toContain('USD 1250.50');
    expect(r.checkout.instructions).toContain('Payment reference (include it in the transfer note): ord_l_1');
    expect(r.checkout.instructions).toContain('ACH routing: 026073150');
    expect(r.checkout.instructions).toContain('to Acme Exports');
  });

  it('picks the account by currency, falls back to "*", and errors when neither exists', async () => {
    const withFallback = ledgerGateway({ receivingAccounts: JSON.stringify([...JSON.parse(ACCOUNTS), { currency: '*', label: 'SWIFT', details: { 'SWIFT/BIC': 'ABCDEF12' } }]) }).gw;
    const eur = await withFallback.createPayment({ orderRef: 'ord_l_eur', amount: 90000, currency: 'EUR' });
    expect(eur.checkout.type === 'manual' && eur.checkout.instructions).toContain('SWIFT/BIC: ABCDEF12');
    const gbp = await withFallback.createPayment({ orderRef: 'ord_l_gbp', amount: 90000, currency: 'GBP' });
    expect(gbp.checkout.type === 'manual' && gbp.checkout.instructions).toContain('Sort code: 04-00-75');
    const { gw } = ledgerGateway();
    await expect(gw.createPayment({ orderRef: 'ord_l_cad', amount: 90000, currency: 'CAD' })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('enforces Skydo rules: no INR, minimum USD 50', async () => {
    const { gw } = ledgerGateway();
    await expect(gw.createPayment({ orderRef: 'ord_l_inr', amount: 100000, currency: 'INR' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ orderRef: 'ord_l_min', amount: 4999, currency: 'USD' })).rejects.toThrow(/USD 50/);
    await expect(gw.createPayment({ orderRef: 'ord_l_ok', amount: 5000, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
  });

  it('is idempotent on orderRef and refuses a changed amount', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_l_2', amount: 100000, currency: 'USD' });
    await expect(gw.createPayment({ orderRef: 'ord_l_2', amount: 100000, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
    await expect(gw.createPayment({ orderRef: 'ord_l_2', amount: 200000, currency: 'USD' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('records partial then full receipts, and lists outstanding orders', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_l_3', amount: 100000, currency: 'USD' });
    await gw.createPayment({ orderRef: 'ord_l_4', amount: 50000, currency: 'USD' });
    const partial = await gw.recordPayment({ orderRef: 'ord_l_3', receiptId: 'SKY-1', amountReceived: 99000, note: 'intermediary bank fee' });
    expect(partial).toMatchObject({ status: 'pending' });
    expect(partial.failureReason).toContain('990.00 of 1000.00');
    expect(gw.outstanding().map((e: { orderRef: string }) => e.orderRef)).toEqual(['ord_l_3', 'ord_l_4']);
    const full = await gw.recordPayment({ orderRef: 'ord_l_3', receiptId: 'SKY-2', amountReceived: 1000, firaNumber: 'FIRA-123' });
    expect(full.status).toBe('captured');
    expect((full.raw as { receipts: unknown[] }).receipts).toHaveLength(2);
    expect(gw.outstanding().map((e: { orderRef: string }) => e.orderRef)).toEqual(['ord_l_4']);
  });

  it('rejects bad receipts', async () => {
    const { gw } = ledgerGateway();
    await expect(gw.recordPayment({ orderRef: 'nope_1', receiptId: 'R1', amountReceived: 100 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await gw.createPayment({ orderRef: 'ord_l_5', amount: 100000, currency: 'USD' });
    await expect(gw.recordPayment({ orderRef: 'ord_l_5', receiptId: 'R1', amountReceived: 10.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.recordPayment({ orderRef: 'ord_l_5', receiptId: 'R1', amountReceived: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('persists the ledger to disk and survives a restart', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const first = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch)) as any;
    await first.createPayment({ orderRef: 'ord_l_6', amount: 100000, currency: 'USD' });
    await first.recordPayment({ orderRef: 'ord_l_6', receiptId: 'R6', amountReceived: 100000 });
    const second = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch));
    expect((await second.getPaymentStatus({ orderRef: 'ord_l_6' })).status).toBe('captured');
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.entries[0]).toMatchObject({ orderRef: 'ord_l_6', amountReceived: 100000 });
  });

  it('refuses to start on a corrupted ledger file instead of overwriting it', () => {
    const file = tempLedger();
    writeFileSync(file, '{broken');
    const f = fakeFetch([]);
    expect(() => skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch))).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('verifies from the ledger (manual_record) and binds the amount', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_l_7', amount: 100000, currency: 'USD' });
    expect(await gw.verifyPayment({ orderRef: 'ord_l_7', expectedAmount: 100000, payload: {} })).toMatchObject({ valid: true, status: 'created', verifiedVia: 'manual_record' });
    await gw.recordPayment({ orderRef: 'ord_l_7', receiptId: 'R7', amountReceived: 100000 });
    expect(await gw.verifyPayment({ orderRef: 'ord_l_7', expectedAmount: 100000, payload: {} })).toMatchObject({ valid: true, status: 'captured' });
    expect((await gw.verifyPayment({ orderRef: 'ord_l_7', expectedAmount: 1, payload: {} })).valid).toBe(false);
  });

  it('says plainly that webhooks do not exist', async () => {
    const { gw } = ledgerGateway();
    await expect(gw.parseWebhook({ headers: {}, rawBody: '' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('skydo Zoho Books bridge', () => {
  const createRoutes = (over: { contacts?: unknown[]; existing?: unknown[]; created?: Record<string, unknown> } = {}): FakeRoute[] => [
    { match: /GET https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\?/, body: { code: 0, message: 'success', invoices: over.existing ?? [] } },
    { match: /GET https:\/\/www\.zohoapis\.in\/books\/v3\/contacts\?/, body: { code: 0, message: 'success', contacts: over.contacts ?? [{ contact_id: '460000000011', contact_name: 'Globex', currency_code: 'USD', status: 'active', email: 'ap@globex.com' }] } },
    { match: /POST https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\/460000000099\/status\/sent\?/, body: { code: 0, message: 'Invoice status has been changed to Sent.' } },
    { match: /GET https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\/460000000099\?/, body: { code: 0, message: 'success', invoice: (over.existing?.[0] as Record<string, unknown>) ?? invoice(over.created) } },
    { match: /POST https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\?/, status: 201, body: { code: 0, message: 'The invoice has been created.', invoice: invoice(over.created) } },
  ];

  it('creates a Zoho invoice exactly as the Zoho Books API documents, then marks it sent', async () => {
    const { gw, requests } = zohoGateway(createRoutes(), { receivingAccounts: ACCOUNTS });
    const r = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' }, description: 'March retainer' });

    // 1. refresh-token grant, form-encoded, to the India accounts host
    expect(requests[0]!.url).toBe('https://accounts.zoho.in/oauth/v2/token');
    expect(Object.fromEntries(new URLSearchParams(requests[0]!.body!))).toEqual({ refresh_token: '1000.refresh', client_id: '1000.CLIENT', client_secret: 'zsecret', grant_type: 'refresh_token' });
    // 2. idempotency lookup by reference_number, 3. contact by email
    expect(requests[1]!.url).toBe('https://www.zohoapis.in/books/v3/invoices?organization_id=60012345&reference_number=ord_skydo_1&per_page=200&page=1');
    expect(requests[2]!.url).toBe('https://www.zohoapis.in/books/v3/contacts?organization_id=60012345&email=ap%40globex.com&contact_type=customer');
    expect(requests[1]!.headers.authorization).toBe('Zoho-oauthtoken 1000.access');
    // 4. create invoice: required customer_id + line_items[].item_id
    expect(requests[3]!.url).toBe('https://www.zohoapis.in/books/v3/invoices?organization_id=60012345');
    const body = JSON.parse(requests[3]!.body!);
    expect(body).toMatchObject({
      customer_id: '460000000011',
      reference_number: 'ord_skydo_1',
      line_items: [{ item_id: '4600000000001', name: 'March retainer', rate: 1200, quantity: 1 }],
    });
    expect(body.notes).toContain('ACH routing: 026073150');
    // 5. race check for a twin invoice with the same reference, 6. draft -> sent so Skydo sees a receivable
    expect(requests[4]!.url).toContain('/books/v3/invoices?organization_id=60012345&reference_number=ord_skydo_1&per_page=200');
    expect(requests[5]!.url).toBe('https://www.zohoapis.in/books/v3/invoices/460000000099/status/sent?organization_id=60012345');
    expect(requests).toHaveLength(6);

    expect(r).toMatchObject({ providerOrderId: '460000000099', status: 'created', amount: 120000, currency: 'USD' });
    expect(r.checkout).toMatchObject({ type: 'manual', url: 'https://books.zoho.in/SecurePayment?CInvoiceID=abc' });
    expect(JSON.stringify(r)).not.toContain('zsecret');
    expect(JSON.stringify(r)).not.toContain('1000.refresh');
  });

  it('sends the invoice by email only when asked, and passes exchange rate and due date', async () => {
    const { gw, requests } = zohoGateway(createRoutes({ created: { status: 'sent' } }));
    await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' }, providerOptions: { sendEmail: true, exchangeRate: 83.25, dueDate: '2026-11-30' } });
    const create = requests.find((q) => q.method === 'POST' && q.url.includes('/books/v3/invoices?'))!;
    expect(create.url).toContain('&send=true');
    expect(JSON.parse(create.body!)).toMatchObject({ exchange_rate: 83.25, due_date: '2026-11-30' });
    expect(requests.some((q) => q.url.includes('/status/sent'))).toBe(false);
  });

  it('is idempotent: an existing invoice with our reference is returned, not duplicated', async () => {
    const { gw, requests } = zohoGateway(createRoutes({ existing: [invoice({ status: 'sent' })] }));
    const r = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } });
    expect(r.providerOrderId).toBe('460000000099');
    expect(requests.filter((q) => q.method === 'POST' && q.url.includes('zohoapis'))).toHaveLength(0);
  });

  it('refuses an existing reference with a different amount', async () => {
    const { gw } = zohoGateway(createRoutes({ existing: [invoice({ total: 999 })] }));
    await expect(gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('requires a Zoho customer in the invoice currency', async () => {
    const none = zohoGateway(createRoutes({ contacts: [] })).gw;
    await expect(none.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'x@y.com' } })).rejects.toThrow(/No Zoho Books customer/);
    const eur = zohoGateway(createRoutes({ contacts: [{ contact_id: '1', contact_name: 'Globex', currency_code: 'EUR', email: 'ap@globex.com' }] })).gw;
    await expect(eur.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toThrow(/billed in EUR/);
    const noEmail = zohoGateway(createRoutes()).gw;
    await expect(noEmail.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD' })).rejects.toThrow(/customer.email/);
  });

  it('reads status from Zoho: paid with FIRA attached -> captured', async () => {
    const { gw } = zohoGateway([{ match: '/books/v3/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'paid', balance: 0, payment_made: 1200, has_attachment: true }) } }]);
    const s = await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' });
    expect(s).toMatchObject({ status: 'captured', amount: 120000, currency: 'USD' });
    expect((s.raw as { firaAttached: boolean }).firaAttached).toBe(true);
  });

  it('maps every Zoho invoice status', () => {
    expect(mapZohoInvoiceStatus('paid')).toBe('captured');
    expect(mapZohoInvoiceStatus('partially_paid')).toBe('pending');
    expect(mapZohoInvoiceStatus('void')).toBe('cancelled');
    for (const s of ['draft', 'sent', 'viewed', 'unpaid', 'overdue']) expect(mapZohoInvoiceStatus(s)).toBe('created');
    expect(mapZohoInvoiceStatus('something_new')).toBe('unknown');
  });

  it('caches the access token across calls', async () => {
    const { gw, requests } = zohoGateway([{ match: '/books/v3/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'sent' }) } }]);
    await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' });
    await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' });
    expect(requests.filter((q) => q.url.includes('oauth/v2/token'))).toHaveLength(1);
  });

  it('refreshes once and retries when Zoho rejects an expired access token', async () => {
    let calls = 0;
    const f = fakeFetch([]);
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return new Response(JSON.stringify({ access_token: `tok${++calls}`, expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Zoho-oauthtoken tok1') return new Response(JSON.stringify({ code: 57, message: 'You are not authorized to perform this operation' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ code: 0, message: 'success', invoice: invoice({ status: 'paid', payment_made: 1200, balance: 0 }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    void f;
    const gw = skydo.create({ ...ZOHO, ledgerFile: tempLedger() }, testContext('skydo', fetch, { extractError: skydo.extractError }));
    expect((await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' })).status).toBe('captured');
    expect(calls).toBe(2);
  });

  it('reports a revoked refresh token as AUTH with a fix', async () => {
    const f = fakeFetch([{ match: 'oauth/v2/token', body: { error: 'invalid_code' } }]);
    const gw = skydo.create({ ...ZOHO, ledgerFile: tempLedger() }, testContext('skydo', f.fetch));
    await expect(gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '1' })).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('surfaces Zoho business errors with their code and message', async () => {
    const { gw } = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: /GET .*\/contacts\?/, body: { code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'G', currency_code: 'USD', email: 'ap@globex.com' }] } },
      { match: /POST .*\/invoices\?/, status: 400, body: { code: 1001, message: 'Invalid value passed for item_id' } },
    ]);
    const err = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '1001', providerMessage: 'Invalid value passed for item_id' });
  });

  it('uses the api_domain Zoho returns with the token', async () => {
    const f = fakeFetch([
      { match: 'oauth/v2/token', body: { access_token: 't', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } },
      { match: 'https://www.zohoapis.com/books/v3/invoices/9?', body: { code: 0, message: 'success', invoice: invoice({ invoice_id: '9', status: 'sent' }) } },
    ]);
    const gw = skydo.create({ ...ZOHO, zohoDataCenter: 'com', ledgerFile: tempLedger() }, testContext('skydo', f.fetch));
    await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '9' });
    expect(f.requests[0]!.url).toBe('https://accounts.zoho.com/oauth/v2/token');
    expect(f.requests[1]!.url.startsWith('https://www.zohoapis.com/books/v3/invoices/9?')).toBe(true);
  });

  it('record_payment is refused in Zoho mode (Skydo marks invoices paid itself)', async () => {
    const { gw } = zohoGateway([]);
    await expect((gw as any).recordPayment({ orderRef: 'ord_skydo_1', amountReceived: 1 })).rejects.toThrow(/Skydo marks invoices paid itself/);
  });
});

describe('skydo through PaymentsClient and MCP', () => {
  it('client enforces Skydo currency rules in every mode, including mock', async () => {
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(mock.createPayment('skydo', { orderRef: 'ord_c_1', amount: 100000 })).rejects.toThrow(/pass the client's currency/);
    await expect(mock.createPayment('skydo', { orderRef: 'ord_c_2', amount: 100000, currency: 'INR' })).rejects.toThrow(/INR is not supported/);
    await expect(mock.createPayment('skydo', { orderRef: 'ord_c_3', amount: 4000, currency: 'USD' })).rejects.toThrow(/USD 50/);
    await expect(mock.createPayment('skydo', { orderRef: 'ord_c_4', amount: 100000, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
  });

  it('full ledger flow over MCP: create -> outstanding -> record -> verify paid', async () => {
    const env = { PAYMENTS_MODE: 'live', PAYMENTS_ALLOW_LIVE_MUTATIONS: 'true', SKYDO_RECEIVING_ACCOUNTS: ACCOUNTS, SKYDO_LEDGER_FILE: tempLedger() };
    const server = createMcpServer(new PaymentsClient({ env, logger: silentLogger, guardLiveMutations: true }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      const t = r.content[0]!.text;
      return { isError: r.isError === true, data: JSON.parse(t.slice(t.indexOf('{'))) };
    };
    const created = await call('payments_create_payment', { provider: 'skydo', order_ref: 'ord_m_1', amount: 250000, currency: 'GBP' });
    expect(created.isError).toBe(false);
    expect(created.data.checkout.instructions).toContain('Sort code: 04-00-75');
    expect((await call('payments_skydo_outstanding', {})).data.outstanding.map((e: { orderRef: string }) => e.orderRef)).toEqual(['ord_m_1']);
    expect((await call('payments_verify_payment', { provider: 'skydo', payload: {}, order_ref: 'ord_m_1', expected_amount: 250000 })).data.paid).toBe(false);
    const blocked = await call('payments_skydo_record_payment', { order_ref: 'ord_m_1', receipt_id: 'SKY-9', amount_received: 250000 });
    expect(blocked).toMatchObject({ isError: true, data: { error: 'LIVE_MUTATION_BLOCKED' } });
    const rec = await call('payments_skydo_record_payment', { order_ref: 'ord_m_1', receipt_id: 'SKY-9', amount_received: 250000, fira_number: 'FIRA-9', confirm: true });
    expect(rec.data.status).toBe('captured');
    expect((await call('payments_verify_payment', { provider: 'skydo', payload: {}, order_ref: 'ord_m_1', expected_amount: 250000 })).data).toMatchObject({ valid: true, paid: true, verifiedVia: 'manual_record' });
    expect((await call('payments_skydo_outstanding', {})).data.outstanding).toEqual([]);
    const refund = await call('payments_refund', { provider: 'skydo', order_ref: 'ord_m_1', refund_ref: 'rf_m_1', confirm: true });
    expect(refund.data.error).toBe('UNSUPPORTED');
  });
});

describe('skydo round-2 regressions (strict review)', () => {
  it('C1: two processes sharing one ledger file never lose each other\'s orders', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const app = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch)) as any;
    const mcp = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch)) as any; // started BEFORE the order exists
    await app.createPayment({ orderRef: 'ord_shared_1', amount: 100000, currency: 'USD' });
    await mcp.createPayment({ orderRef: 'ord_shared_2', amount: 60000, currency: 'USD' });
    // The MCP process sees the app's order and its write keeps it.
    expect((await mcp.recordPayment({ orderRef: 'ord_shared_1', receiptId: 'SKY-A', amountReceived: 100000 })).status).toBe('captured');
    await app.createPayment({ orderRef: 'ord_shared_3', amount: 70000, currency: 'USD' });
    const onDisk = JSON.parse(readFileSync(file, 'utf8')).entries.map((e: { orderRef: string }) => e.orderRef).sort();
    expect(onDisk).toEqual(['ord_shared_1', 'ord_shared_2', 'ord_shared_3']);
    expect((await app.getPaymentStatus({ orderRef: 'ord_shared_1' })).status).toBe('captured');
  });

  it('C1: a stale lock left by a crashed process is broken', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    writeFileSync(`${file}.lock`, '');
    const { utimesSync } = await import('node:fs');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const gw = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch));
    await expect(gw.createPayment({ orderRef: 'ord_lock_1', amount: 100000, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
  });

  it('H1: a Zoho invoice written off as bad debt is NOT paid', async () => {
    const { gw } = zohoGateway([{ match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'paid', balance: 0, payment_made: 0, write_off_amount: 1200 }) } }]);
    const s = await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' });
    expect(s.status).toBe('failed');
    expect(s.failureReason).toMatch(/written off/);
  });

  it('H1: a Zoho invoice closed with credit notes is NOT captured', async () => {
    const { gw } = zohoGateway([{ match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'paid', balance: 0, payment_made: 200, credits_applied: 1000 }) } }]);
    expect((await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' })).status).toBe('unknown');
  });

  it('H1: paid=true through the client only when money covers the total', async () => {
    const make = (inv: Record<string, unknown>) =>
      new PaymentsClient({
        env: { PAYMENTS_MODE: 'sandbox', ZOHO_DATA_CENTER: 'in', ZOHO_CLIENT_ID: 'c', ZOHO_CLIENT_SECRET: 's', ZOHO_REFRESH_TOKEN: 'r', ZOHO_ORGANIZATION_ID: '1', ZOHO_ITEM_ID: 'i', SKYDO_LEDGER_FILE: tempLedger() },
        logger: silentLogger,
        fetch: fakeFetch([TOKEN, { match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice(inv) } }]).fetch,
      });
    const ok = await make({ status: 'paid', payment_made: 1200, balance: 0 }).verifyPayment('skydo', { orderRef: 'ord_skydo_1', providerOrderId: '460000000099', expectedAmount: 120000, payload: {} });
    expect(ok.paid).toBe(true);
    const writeOff = await make({ status: 'paid', payment_made: 0, write_off_amount: 1200, balance: 0 }).verifyPayment('skydo', { orderRef: 'ord_skydo_1', providerOrderId: '460000000099', expectedAmount: 120000, payload: {} });
    expect(writeOff.paid).toBe(false);
  });

  it('H2: a providerOrderId for a different order is refused', async () => {
    const { gw } = zohoGateway([{ match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ reference_number: 'ord_OTHER', status: 'paid', payment_made: 1200 }) } }]);
    await expect(gw.verifyPayment({ orderRef: 'ord_A', providerOrderId: '460000000099', expectedAmount: 120000, payload: {} })).rejects.toThrow(/reference ord_OTHER, not ord_A/);
  });

  it('H3: the same receipt recorded twice is counted once; a conflicting amount is rejected', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_dup_1', amount: 100000, currency: 'USD' });
    expect((await gw.recordPayment({ orderRef: 'ord_dup_1', receiptId: 'SKY-77', amountReceived: 60000 })).status).toBe('pending');
    expect((await gw.recordPayment({ orderRef: 'ord_dup_1', receiptId: 'SKY-77', amountReceived: 60000 })).status).toBe('pending');
    await expect(gw.recordPayment({ orderRef: 'ord_dup_1', receiptId: 'SKY-77', amountReceived: 1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(gw.recordPayment({ orderRef: 'ord_dup_1', receiptId: ' ', amountReceived: 1 })).rejects.toThrow(/receiptId is required/);
  });

  it('H4: through the MCP server, recording a receipt in live mode needs the server flag AND confirm', async () => {
    const env = { PAYMENTS_MODE: 'live', SKYDO_RECEIVING_ACCOUNTS: ACCOUNTS, SKYDO_LEDGER_FILE: tempLedger() };
    const c = new PaymentsClient({ env, logger: silentLogger, guardLiveMutations: true });
    await c.createPayment('skydo', { orderRef: 'ord_h4_1', amount: 100000, currency: 'USD' });
    await expect(c.skydoRecordPayment({ orderRef: 'ord_h4_1', receiptId: 'R', amountReceived: 100000 }, { confirm: true })).rejects.toMatchObject({ code: 'LIVE_MUTATION_BLOCKED' });
    // Your own app (no guard) can record receipts behind its own admin auth.
    const app = new PaymentsClient({ env, logger: silentLogger });
    expect((await app.skydoRecordPayment({ orderRef: 'ord_h4_1', receiptId: 'R', amountReceived: 100000 })).status).toBe('captured');
  });

  it('M1: a retry repairs an invoice left in draft by an earlier failure', async () => {
    const { gw, requests } = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [invoice({ status: 'draft' })] } },
      { match: /status\/sent/, body: { code: 0, message: 'ok' } },
      { match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'draft' }) } },
    ]);
    const r = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } });
    expect(r.status).toBe('created');
    expect(requests.filter((q) => q.url.includes('/status/sent'))).toHaveLength(1);
  });

  it('M4: a twin invoice created by a concurrent process is voided and the oldest is kept', async () => {
    let lookups = 0;
    const older = invoice({ invoice_id: '460000000050', status: 'sent', created_time: '2026-10-28T09:00:00+0530' });
    const ours = invoice({ invoice_id: '460000000099', status: 'sent', created_time: '2026-10-28T09:00:05+0530' });
    const f = fakeFetch([]);
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes('oauth/v2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'GET' && url.includes('/invoices?')) {
        lookups++;
        return new Response(JSON.stringify({ code: 0, message: 'success', invoices: lookups === 1 ? [] : [ours, older] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/contacts?')) return new Response(JSON.stringify({ code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'G', currency_code: 'USD', email: 'ap@globex.com' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/status/void')) return new Response(JSON.stringify({ code: 0, message: 'voided' }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'GET' && url.includes('/invoices/460000000050?')) return new Response(JSON.stringify({ code: 0, message: 'success', invoice: older }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ code: 0, message: 'created', invoice: ours }), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    void f;
    const voided: string[] = [];
    const spy = async (url: string, init?: RequestInit) => {
      if (url.includes('/status/void')) voided.push(url);
      return fetch(url, init);
    };
    const gw = skydo.create({ ...ZOHO, ledgerFile: tempLedger() }, testContext('skydo', spy));
    const r = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } });
    expect(r.providerOrderId).toBe('460000000050');
    expect(voided).toHaveLength(1);
    expect(voided[0]).toContain('/invoices/460000000099/status/void');
  });

  it('M4: the reference lookup pages through results and ignores near-matches', async () => {
    const page1 = { code: 0, message: 'success', invoices: [invoice({ reference_number: 'ord_skydo_10' })], page_context: { has_more_page: true } };
    const page2 = { code: 0, message: 'success', invoices: [invoice({ invoice_id: '7', reference_number: 'ord_skydo_1', status: 'sent' })], page_context: { has_more_page: false } };
    const { gw, requests } = zohoGateway([
      { match: /page=1/, body: page1 },
      { match: /page=2/, body: page2 },
      { match: '/invoices/7?', body: { code: 0, message: 'success', invoice: invoice({ invoice_id: '7', status: 'sent' }) } },
    ]);
    expect((await gw.getPaymentStatus({ orderRef: 'ord_skydo_1' })).providerOrderId).toBe('7');
    expect(requests.filter((q) => q.url.includes('per_page=200'))).toHaveLength(2);
  });

  it('M5: a voided invoice reports cancelled instead of NOT_FOUND, and its orderRef cannot be reused', async () => {
    const voided = invoice({ status: 'void' });
    const { gw } = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [voided] } },
      { match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: voided } },
    ]);
    expect((await gw.getPaymentStatus({ orderRef: 'ord_skydo_1' })).status).toBe('cancelled');
    await expect(gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toThrow(/voided/);
  });

  it('M6: customer lookup re-checks the email and refuses to guess', async () => {
    const two = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: /contacts/, body: { code: 0, message: 'success', contacts: [
        { contact_id: '1', contact_name: 'A', currency_code: 'USD', email: 'ap@globex.com', status: 'active' },
        { contact_id: '2', contact_name: 'B', currency_code: 'USD', email: 'AP@globex.com', status: 'active' },
      ] } },
    ]).gw;
    await expect(two.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toThrow(/2 active Zoho Books customers/);
    const inactive = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: /contacts/, body: { code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'A', currency_code: 'USD', email: 'ap@globex.com', status: 'inactive' }] } },
    ]).gw;
    await expect(inactive.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toThrow(/inactive/);
    const other = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: /contacts/, body: { code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'A', currency_code: 'USD', email: 'someone@else.com', status: 'active' }] } },
    ]).gw;
    await expect(other.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } })).rejects.toThrow(/No Zoho Books customer/);
  });

  it('M2: with ZOHO_ACCOUNTS_URL the first call goes to the api_domain Zoho returned', async () => {
    const f = fakeFetch([
      { match: 'https://accounts.example-zoho.test/oauth/v2/token', body: { access_token: 't', expires_in: 3600, api_domain: 'https://www.zohoapis.in' } },
      { match: 'https://www.zohoapis.in/books/v3/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'sent' }) } },
    ]);
    const gw = skydo.create({ ...ZOHO, zohoDataCenter: 'unlisted', zohoAccountsUrl: 'https://accounts.example-zoho.test', ledgerFile: tempLedger() }, testContext('skydo', f.fetch));
    expect((await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' })).status).toBe('created');
    expect(f.requests).toHaveLength(2);
  });

  it('M3: UAE, UK and Singapore Zoho regions are supported', () => {
    const f = fakeFetch([]);
    for (const dc of ['ae', 'uk', 'sg', 'ca']) expect(() => skydo.create({ ...ZOHO, zohoDataCenter: dc }, testContext('skydo', f.fetch))).not.toThrow();
  });

  it('L2/L3: bad dates and non-ISO currencies are rejected', async () => {
    const { gw } = ledgerGateway();
    await expect(gw.createPayment({ orderRef: 'ord_l3_1', amount: 100000, currency: 'dollars' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await gw.createPayment({ orderRef: 'ord_l2_1', amount: 100000, currency: 'USD' });
    await expect(gw.recordPayment({ orderRef: 'ord_l2_1', receiptId: 'R', amountReceived: 1, receivedAt: 'yesterday' })).rejects.toThrow(/not an ISO 8601 date/);
  });

  it('L4: a rate-limited token refresh is reported as RATE_LIMITED, not as a revoked token', async () => {
    const f = fakeFetch([{ match: 'oauth/v2/token', body: { error: 'Access Denied', error_description: 'You have made too many requests continuously. Please try again after some time.' } }]);
    const gw = skydo.create({ ...ZOHO, ledgerFile: tempLedger() }, testContext('skydo', f.fetch));
    await expect(gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '1' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('L6: a corrupt ledger file does not block the Zoho bridge', () => {
    const file = tempLedger();
    writeFileSync(file, '{broken');
    const f = fakeFetch([]);
    expect(() => skydo.create({ ...ZOHO, ledgerFile: file }, testContext('skydo', f.fetch))).not.toThrow();
  });

  it('L1/L10: non-USD invoices carry the USD-50-equivalent note; long GBP references are flagged', async () => {
    const { gw } = ledgerGateway();
    const r = await gw.createPayment({ orderRef: 'ord_gbp_reference_long', amount: 100000, currency: 'GBP' });
    const text = r.checkout.type === 'manual' ? r.checkout.instructions : '';
    expect(text).toMatch(/equivalent of USD 50/);
    expect(text).toMatch(/18 characters/);
  });
});

describe('skydo round-3 regressions', () => {
  /** A tiny stateful fake of the Zoho invoices API, shared by several gateways (= processes). */
  function statefulZoho() {
    let nextId = 460000000100;
    const invoices: any[] = [];
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const fetch = async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (url.includes('oauth/v2/token')) return json({ access_token: 't', expires_in: 3600 });
      if (u.pathname.endsWith('/contacts')) return json({ code: 0, message: 'success', contacts: [{ contact_id: '1', contact_name: 'G', currency_code: 'USD', email: 'ap@globex.com', status: 'active' }] });
      const m = /\/invoices\/(\d+)(\/status\/(\w+))?$/.exec(u.pathname);
      if (m) {
        const inv = invoices.find((i) => i.invoice_id === m[1]);
        if (m[3]) inv.status = m[3];
        return json({ code: 0, message: 'success', invoice: inv });
      }
      if (init?.method === 'GET') return json({ code: 0, message: 'success', invoices: invoices.filter((i) => i.reference_number === u.searchParams.get('reference_number')), page_context: { has_more_page: false } });
      const body = JSON.parse(String(init!.body));
      const inv = invoice({ invoice_id: String(nextId++), reference_number: body.reference_number, status: 'draft' });
      invoices.push(inv);
      return json({ code: 0, message: 'created', invoice: inv }, 201);
    };
    return { fetch, invoices };
  }

  it('N1: two processes racing on one orderRef end with exactly ONE live invoice, and both return it', async () => {
    const z = statefulZoho();
    // Both pass the "no invoice yet" lookup before either creates: delay creates until both looked.
    let looked = 0;
    let release!: () => void;
    const bothLooked = new Promise<void>((r) => (release = r));
    const gated = async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && new URL(url).pathname.endsWith('/invoices')) await bothLooked;
      const res = await z.fetch(url, init);
      if (init?.method === 'GET' && url.includes('reference_number') && ++looked === 2) release();
      return res;
    };
    const mk = () => skydo.create({ ...ZOHO, ledgerFile: tempLedger() }, testContext('skydo', gated));
    const input = { orderRef: 'ord_race_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } };
    const [a, b] = await Promise.all([mk().createPayment(input), mk().createPayment(input)]);
    expect(z.invoices).toHaveLength(2);
    const live = z.invoices.filter((i) => i.status !== 'void');
    expect(live).toHaveLength(1);
    expect(a.providerOrderId).toBe(live[0].invoice_id);
    expect(b.providerOrderId).toBe(live[0].invoice_id);
    expect(live[0].status).toBe('sent');
  });

  it('N6: a partly written-off invoice (bank fees) is pending for review, not failed', async () => {
    const { gw } = zohoGateway([{ match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'paid', balance: 0, payment_made: 1190, write_off_amount: 10 }) } }]);
    const s = await gw.getPaymentStatus({ orderRef: 'ord_skydo_1', providerOrderId: '460000000099' });
    expect(s.status).toBe('pending');
    expect(s.failureReason).toMatch(/Received USD 1190 of 1200; 10 was written off/);
  });

  it('N8: a retry that finds the invoice returns the full record (invoice link, real status)', async () => {
    const { gw } = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [{ ...invoice({ status: 'paid' }), invoice_url: undefined, payment_made: undefined }] } },
      { match: '/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice({ status: 'paid', payment_made: 1200, balance: 0 }) } },
    ]);
    const r = await gw.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } });
    expect(r.status).toBe('captured');
    expect(r.checkout).toMatchObject({ url: 'https://books.zoho.in/SecurePayment?CInvoiceID=abc' });
  });

  it('N9: an explicit zohoCustomerId must be an active customer', async () => {
    const vendor = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: '/contacts/77?', body: { code: 0, message: 'success', contact: { contact_id: '77', contact_name: 'Supplier', contact_type: 'vendor', currency_code: 'USD' } } },
    ]).gw;
    await expect(vendor.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', providerOptions: { zohoCustomerId: '77' } })).rejects.toThrow(/not a customer/);
    const inactive = zohoGateway([
      { match: /GET .*\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
      { match: '/contacts/78?', body: { code: 0, message: 'success', contact: { contact_id: '78', contact_name: 'Old', contact_type: 'customer', status: 'inactive', currency_code: 'USD' } } },
    ]).gw;
    await expect(inactive.createPayment({ orderRef: 'ord_skydo_1', amount: 120000, currency: 'USD', providerOptions: { zohoCustomerId: '78' } })).rejects.toThrow(/inactive/);
  });

  it('N16: receivedAt must be an ISO date and not in the future', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_n16', amount: 100000, currency: 'USD' });
    await expect(gw.recordPayment({ orderRef: 'ord_n16', receiptId: 'R', amountReceived: 1, receivedAt: '1' })).rejects.toThrow(/ISO 8601/);
    await expect(gw.recordPayment({ orderRef: 'ord_n16', receiptId: 'R', amountReceived: 1, receivedAt: '2099-01-01' })).rejects.toThrow(/future/);
    await expect(gw.recordPayment({ orderRef: 'ord_n16', receiptId: 'R', amountReceived: 1, receivedAt: '2026-10-27' })).resolves.toMatchObject({ status: 'pending' });
  });

  it('N18: receipt ids are case-insensitive and one receipt cannot pay two orders', async () => {
    const { gw } = ledgerGateway();
    await gw.createPayment({ orderRef: 'ord_n18_a', amount: 100000, currency: 'USD' });
    await gw.createPayment({ orderRef: 'ord_n18_b', amount: 100000, currency: 'USD' });
    await gw.recordPayment({ orderRef: 'ord_n18_a', receiptId: 'sky-tx-1', amountReceived: 50000 });
    expect((await gw.recordPayment({ orderRef: 'ord_n18_a', receiptId: ' SKY-TX-1 ', amountReceived: 50000 })).status).toBe('pending');
    await expect(gw.recordPayment({ orderRef: 'ord_n18_b', receiptId: 'SKY-TX-1', amountReceived: 50000 })).rejects.toThrow(/already recorded on order ord_n18_a/);
  });

  it('N13: waiting for the ledger lock does not freeze the event loop', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const gw = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch));
    writeFileSync(`${file}.lock`, 'someone-else'); // a fresh (not stale) lock held by another process
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const pending = gw.createPayment({ orderRef: 'ord_n13', amount: 100000, currency: 'USD' });
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(5);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(`${file}.lock`);
    await expect(pending).resolves.toMatchObject({ status: 'created' });
  });

  it('N14: a process never deletes a lock it does not own', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const gw = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch));
    await gw.createPayment({ orderRef: 'ord_n14', amount: 100000, currency: 'USD' });
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${file}.lock`)).toBe(false); // released after use
  });
});
