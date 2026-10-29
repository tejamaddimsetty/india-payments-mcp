import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { PaymentsClient } from '../../src/client.js';
import { generateIntegration, FRAMEWORKS } from '../../src/codegen/index.js';
import { recommendGateways } from '../../src/codegen/recommend.js';
import { allCapabilities } from '../../src/providers/index.js';
import { silentLogger } from '../../src/core/logger.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { infinity, InfinityGateway, validateQuickLink, type InfinityCredentials } from '../../src/providers/infinity/adapter.js';
import { fakeFetch, testContext } from '../helpers.js';

const ACCOUNTS = JSON.stringify([
  { currency: 'USD', label: 'US account (ACH)', details: { 'Account holder': 'Asha Studio', 'Account number': '9876543210', 'ACH routing': '021000021' } },
  { currency: '*', label: 'SWIFT', details: { 'SWIFT/BIC': 'INFYXX22', 'Account number': 'GB00INFY0000' } },
]);
const LINK = 'https://pay.infinityapp.in/q/abc123';
const CONFIG_RE = /not a host name|too broad/;

const tempLedger = () => join(mkdtempSync(join(tmpdir(), 'infinity-')), 'ledger.json');

function gateway(extra: Partial<InfinityCredentials> = {}) {
  const f = fakeFetch([]);
  const gw = infinity.create({ receivingAccounts: ACCOUNTS, payeeName: 'Asha Studio', ledgerFile: tempLedger(), ...extra }, testContext('infinity', f.fetch)) as InfinityGateway;
  return { gw, ...f };
}

describe('infinity configuration', () => {
  it('needs receiving accounts or QuickLink-only mode, and explains how', () => {
    const f = fakeFetch([]);
    expect(() => infinity.create({}, testContext('infinity', f.fetch))).toThrow(/INFINITY_RECEIVING_ACCOUNTS.*INFINITY_QUICKLINK_ONLY/);
    expect(() => infinity.create({ quickLinkOnly: 'true', ledgerFile: tempLedger() }, testContext('infinity', f.fetch))).not.toThrow();
    expect(() => infinity.create({ quickLinkOnly: 'maybe' }, testContext('infinity', f.fetch))).toThrow(/true or false/);
    expect(() => infinity.create({ receivingAccounts: '[]' }, testContext('infinity', f.fetch))).toThrow(/INFINITY_RECEIVING_ACCOUNTS must be a non-empty/);
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, quickLinkHosts: 'https://evil.example/x' }, testContext('infinity', f.fetch))).toThrow(/not a host name/);
  });

  it('never makes a network call', async () => {
    const { gw, requests } = gateway();
    await gw.createPayment({ orderRef: 'ord_net_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    await gw.recordPayment({ orderRef: 'ord_net_1', receiptId: 'INF-1', amountReceived: 100000 });
    await gw.getPaymentStatus({ orderRef: 'ord_net_1' });
    expect(requests).toEqual([]);
  });
});

describe('infinity payments', () => {
  it('bank transfer: right account for the currency, orderRef as reference, SWIFT fallback', async () => {
    const { gw } = gateway();
    const usd = await gw.createPayment({ orderRef: 'ord_i_1', amount: 125050, currency: 'usd' });
    expect(usd).toMatchObject({ provider: 'infinity', providerOrderId: 'infinity:ord_i_1', status: 'created', amount: 125050, currency: 'USD' });
    if (usd.checkout.type !== 'manual') throw new Error('expected manual');
    expect(usd.checkout.url).toBeUndefined();
    expect(usd.checkout.instructions).toContain('USD 1250.50 by bank transfer to Asha Studio');
    expect(usd.checkout.instructions).toContain('Payment reference (include it in the transfer note): ord_i_1');
    expect(usd.checkout.instructions).toContain('ACH routing: 021000021');
    expect(usd.checkout.instructions).toContain('through Infinity (infinityapp.in)');
    expect(usd.checkout.instructions).not.toMatch(/Skydo/);
    const eur = await gw.createPayment({ orderRef: 'ord_i_2', amount: 90000, currency: 'EUR' });
    expect(eur.checkout.type === 'manual' && eur.checkout.instructions).toContain('SWIFT/BIC: INFYXX22');
  });

  it('rejects INR, missing and malformed currencies; enforces no undocumented minimum', async () => {
    const { gw } = gateway();
    await expect(gw.createPayment({ orderRef: 'ord_i_inr', amount: 100000, currency: 'INR' })).rejects.toThrow(/INR is not supported/);
    await expect(gw.createPayment({ orderRef: 'ord_i_none', amount: 100000 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ orderRef: 'ord_i_bad', amount: 100000, currency: 'dollars' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ orderRef: 'ord_i_small', amount: 100, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
  });

  it('QuickLink: link + bank details, and the amount warning', async () => {
    const { gw } = gateway();
    const r = await gw.createPayment({ orderRef: 'ord_q_1', amount: 250000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    if (r.checkout.type !== 'manual') throw new Error('expected manual');
    expect(r.checkout.url).toBe(LINK);
    expect(r.checkout.instructions).toContain(`online (card or bank transfer): ${LINK}`);
    expect(r.checkout.instructions).toContain('Or pay by bank transfer:');
    expect(r.checkout.instructions).toContain('exactly USD 2500.00');
    expect((await gw.getPaymentStatus({ orderRef: 'ord_q_1' })).method).toBe('quicklink_or_bank_transfer');
  });

  it('QuickLink-only mode: needs a link per payment, no bank details printed', async () => {
    const { gw } = gateway({ receivingAccounts: undefined, quickLinkOnly: 'true' });
    await expect(gw.createPayment({ orderRef: 'ord_qo_1', amount: 100000, currency: 'USD' })).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    const r = await gw.createPayment({ orderRef: 'ord_qo_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    expect(r.checkout.type === 'manual' && r.checkout.instructions).not.toContain('Account number');
    // Re-asking without the link reuses the stored link (resend instructions).
    const again = await gw.createPayment({ orderRef: 'ord_qo_1', amount: 100000, currency: 'USD' });
    expect(again.checkout).toMatchObject({ type: 'manual', url: LINK });
    expect(again.checkout.type === 'manual' && again.checkout.instructions).toContain(LINK);
  });

  it('rejects links that could send the client somewhere else', () => {
    const hosts = ['*.infinityapp.in'];
    for (const bad of [
      'http://pay.infinityapp.in/q/1',
      'https://infinityapp.in.evil.com/q/1',
      'https://evilinfinityapp.in/q/1',
      'https://user:pw@pay.infinityapp.in/q/1',
      'https://pay.infinityapp.in:8443/q/1',
      'javascript:alert(1)',
      'not a url',
      '',
      42,
      `https://pay.infinityapp.in/${'a'.repeat(2100)}`,
    ]) {
      expect(() => validateQuickLink(bad, hosts), String(bad).slice(0, 60)).toThrow();
    }
    expect(validateQuickLink('https://infinityapp.in/pay/1', hosts)).toBe('https://infinityapp.in/pay/1');
    expect(validateQuickLink(' https://Pay.InfinityApp.in/q/1 ', hosts)).toBe('https://pay.infinityapp.in/q/1');
    expect(() => validateQuickLink('https://links.example.com/x', hosts)).toThrow(/https link on infinityapp.in/);
    try {
      validateQuickLink('https://links.example.com/x', hosts);
    } catch (e) {
      expect((e as { hint?: string }).hint).toMatch(/INFINITY_QUICKLINK_HOSTS/);
    }
    expect(validateQuickLink('https://links.example.com/x', ['links.example.com'])).toBe('https://links.example.com/x');
    // A bare host matches exactly; only "*." allows subdomains.
    expect(() => validateQuickLink('https://evil.links.example.com/x', ['links.example.com'])).toThrow();
  });

  it('one order per orderRef: no re-pricing, no swapping the link, attaching a first link is allowed', async () => {
    const { gw } = gateway();
    await gw.createPayment({ orderRef: 'ord_r_1', amount: 100000, currency: 'USD' });
    await expect(gw.createPayment({ orderRef: 'ord_r_1', amount: 200000, currency: 'USD' })).rejects.toThrow(/different amount or currency/);
    await expect(gw.createPayment({ orderRef: 'ord_r_1', amount: 100000, currency: 'GBP' })).rejects.toThrow(/different amount or currency/);
    const attached = await gw.createPayment({ orderRef: 'ord_r_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    expect(attached.checkout).toMatchObject({ url: LINK });
    await expect(gw.createPayment({ orderRef: 'ord_r_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: 'https://pay.infinityapp.in/q/OTHER' } })).rejects.toThrow(/different payment link/);
  });

  it('receipts: partial stays pending, duplicates are no-ops, one receipt pays one order', async () => {
    const { gw } = gateway();
    await gw.createPayment({ orderRef: 'ord_p_1', amount: 100000, currency: 'USD' });
    await gw.createPayment({ orderRef: 'ord_p_2', amount: 50000, currency: 'USD' });
    const partial = await gw.recordPayment({ orderRef: 'ord_p_1', receiptId: 'INF-77', amountReceived: 99000 });
    expect(partial).toMatchObject({ status: 'pending' });
    expect(partial.failureReason).toContain('990.00 of 1000.00');
    expect((await gw.recordPayment({ orderRef: 'ord_p_1', receiptId: ' inf-77 ', amountReceived: 99000 })).status).toBe('pending');
    await expect(gw.recordPayment({ orderRef: 'ord_p_1', receiptId: 'INF-77', amountReceived: 1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(gw.recordPayment({ orderRef: 'ord_p_2', receiptId: 'inf-77', amountReceived: 50000 })).rejects.toThrow(/already recorded on order ord_p_1/);
    expect((await gw.recordPayment({ orderRef: 'ord_p_1', receiptId: 'INF-78', amountReceived: 1000 })).status).toBe('captured');
    expect(gw.outstanding().map((e) => e.orderRef)).toEqual(['ord_p_2']);
    await expect(gw.recordPayment({ orderRef: 'nope_1', receiptId: 'R1', amountReceived: 100 })).rejects.toThrow(/Infinity ledger has no order nope_1/);
    await expect(gw.recordPayment({ orderRef: 'ord_p_2', receiptId: ' ', amountReceived: 1 })).rejects.toThrow(/Infinity transaction reference/);
    await expect(gw.recordPayment({ orderRef: 'ord_p_2', receiptId: 'R', amountReceived: 10.5 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.recordPayment({ orderRef: 'ord_p_2', receiptId: 'R', amountReceived: 1, receivedAt: '2099-01-01' })).rejects.toThrow(/future/);
  });

  it('verify: valid only with the expected amount; never paid before a receipt', async () => {
    const { gw } = gateway();
    await gw.createPayment({ orderRef: 'ord_v_1', amount: 100000, currency: 'USD' });
    expect(await gw.verifyPayment({ orderRef: 'ord_v_1', expectedAmount: 100000, payload: {} })).toMatchObject({ valid: true, status: 'created', verifiedVia: 'manual_record' });
    expect(await gw.verifyPayment({ orderRef: 'ord_v_1', expectedAmount: 1, payload: {} })).toMatchObject({ valid: false });
    await gw.recordPayment({ orderRef: 'ord_v_1', receiptId: 'INF-1', amountReceived: 100000 });
    expect(await gw.verifyPayment({ orderRef: 'ord_v_1', expectedAmount: 100000, payload: {} })).toMatchObject({ valid: true, status: 'captured' });
    await expect(gw.parseWebhook()).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('ledger survives a restart and is its own file (not the Skydo ledger)', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const a = infinity.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('infinity', f.fetch)) as InfinityGateway;
    await a.createPayment({ orderRef: 'ord_d_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    await a.recordPayment({ orderRef: 'ord_d_1', receiptId: 'INF-5', amountReceived: 100000 });
    const b = infinity.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('infinity', f.fetch)) as InfinityGateway;
    expect(await b.getPaymentStatus({ orderRef: 'ord_d_1' })).toMatchObject({ status: 'captured', provider: 'infinity' });
    expect(JSON.parse(readFileSync(file, 'utf8')).entries[0]).toMatchObject({ orderRef: 'ord_d_1', paymentUrl: LINK, amountReceived: 100000 });
  });
});

describe('infinity through PaymentsClient and MCP', () => {
  it('client enforces Infinity currency rules in mock mode too', async () => {
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(mock.createPayment('infinity', { orderRef: 'ord_c_1', amount: 100000 })).rejects.toThrow(/pass the client's currency/);
    await expect(mock.createPayment('infinity', { orderRef: 'ord_c_2', amount: 100000, currency: 'INR' })).rejects.toThrow(/INR is not supported/);
    await expect(mock.createPayment('infinity', { orderRef: 'ord_c_3', amount: 100000, currency: 'USD' })).resolves.toMatchObject({ status: 'created' });
    await expect(mock.infinityRecordPayment({ orderRef: 'ord_c_3', receiptId: 'R', amountReceived: 1 })).rejects.toThrow(/Mock mode simulates Infinity/);
  });

  it('refunds, subscriptions and webhooks are UNSUPPORTED, not faked', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox', INFINITY_RECEIVING_ACCOUNTS: ACCOUNTS, INFINITY_LEDGER_FILE: tempLedger() }, logger: silentLogger });
    await expect(c.refund('infinity', { orderRef: 'ord_u_1', refundRef: 'rf_u_1' } as never)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('the MCP gate applies in sandbox too (Infinity documents no sandbox), app code is not gated', async () => {
    const env = { PAYMENTS_MODE: 'sandbox', INFINITY_RECEIVING_ACCOUNTS: ACCOUNTS, INFINITY_LEDGER_FILE: tempLedger() };
    const agent = new PaymentsClient({ env, logger: silentLogger, guardLiveMutations: true });
    await agent.createPayment('infinity', { orderRef: 'ord_g_1', amount: 100000, currency: 'USD' });
    await expect(agent.infinityRecordPayment({ orderRef: 'ord_g_1', receiptId: 'R', amountReceived: 100000 }, { confirm: true })).rejects.toThrow(/Infinity documents no sandbox/);
    const app = new PaymentsClient({ env, logger: silentLogger });
    expect((await app.infinityRecordPayment({ orderRef: 'ord_g_1', receiptId: 'R', amountReceived: 100000 })).status).toBe('captured');
  });

  it('full flow over MCP: create with QuickLink -> outstanding -> blocked -> record -> verify paid', async () => {
    const env = { PAYMENTS_MODE: 'live', PAYMENTS_ALLOW_LIVE_MUTATIONS: 'true', INFINITY_RECEIVING_ACCOUNTS: ACCOUNTS, INFINITY_LEDGER_FILE: tempLedger() };
    const server = createMcpServer(new PaymentsClient({ env, logger: silentLogger, guardLiveMutations: true }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
      const t = r.content[0]!.text;
      return { isError: r.isError === true, data: JSON.parse(t.slice(t.indexOf('{'))) };
    };
    const created = await call('payments_create_payment', { provider: 'infinity', order_ref: 'ord_m_1', amount: 250000, currency: 'USD', provider_options: { quickLinkUrl: LINK } });
    expect(created.isError).toBe(false);
    expect(created.data.checkout).toMatchObject({ type: 'manual', url: LINK });
    const phishing = await call('payments_create_payment', { provider: 'infinity', order_ref: 'ord_m_2', amount: 250000, currency: 'USD', provider_options: { quickLinkUrl: 'https://infinity-pay.example/q' } });
    expect(phishing).toMatchObject({ isError: true, data: { error: 'VALIDATION' } });
    expect((await call('payments_infinity_outstanding', {})).data.outstanding.map((e: { orderRef: string }) => e.orderRef)).toEqual(['ord_m_1']);
    expect((await call('payments_verify_payment', { provider: 'infinity', payload: {}, order_ref: 'ord_m_1', expected_amount: 250000 })).data.paid).toBe(false);
    const blocked = await call('payments_infinity_record_payment', { order_ref: 'ord_m_1', receipt_id: 'INF-9', amount_received: 250000 });
    expect(blocked).toMatchObject({ isError: true, data: { error: 'LIVE_MUTATION_BLOCKED' } });
    const rec = await call('payments_infinity_record_payment', { order_ref: 'ord_m_1', receipt_id: 'INF-9', amount_received: 250000, confirm: true });
    expect(rec.data.status).toBe('captured');
    expect((await call('payments_verify_payment', { provider: 'infinity', payload: {}, order_ref: 'ord_m_1', expected_amount: 250000 })).data).toMatchObject({ valid: true, paid: true, verifiedVia: 'manual_record' });
    expect((await call('payments_infinity_outstanding', {})).data.outstanding).toEqual([]);
  });

  it('mock mode: full lifecycle without any configuration', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await c.createPayment('infinity', { orderRef: 'ord_mk_1', amount: 100000, currency: 'USD' });
    await c.mockGateway('infinity').complete('ord_mk_1', 'success');
    expect(await c.verifyPayment('infinity', { orderRef: 'ord_mk_1', expectedAmount: 100000, payload: {} })).toMatchObject({ paid: true });
  });

  it('recommends Infinity for exporter collections, after Skydo', () => {
    const ranking = recommendGateways(['exporter_collections'], allCapabilities()).ranking.map((r: { provider: string }) => r.provider);
    expect(ranking.slice(0, 2)).toEqual(['skydo', 'infinity']);
  });
});

describe('infinity codegen', () => {
  it.each(FRAMEWORKS)('infinity / %s: honest warning, SDK-only code, receipts behind admin auth', (framework) => {
    const r = generateIntegration({ provider: 'infinity', framework });
    expect(r.warnings.join(' ')).toMatch(/publishes no developer API/i);
    const all = r.files.map((f) => f.contents).join('\n');
    expect(all).toContain("from 'india-payments-mcp'");
    expect(all).toContain('infinityRecordPayment');
    expect(all).not.toMatch(/skydoRecordPayment|createPayment\('skydo'|api\/skydo/);
    expect(all).toContain('INFINITY_ZOHO_REFRESH_TOKEN');
    expect(all).toContain('Connect** tab > **Zoho Books');
    expect(all).not.toMatch(/fetch\(['"`]https:\/\/[^'"`]*infinityapp/);
    const env = r.files.find((f) => f.path === '.env.example')!.contents;
    for (const v of ['INFINITY_RECEIVING_ACCOUNTS', 'INFINITY_QUICKLINK_ONLY', 'INFINITY_ZOHO_ITEM_ID', 'ADMIN_API_TOKEN']) expect(env).toContain(v);
    expect(r.files.some((f) => f.path === 'docs/INFINITY_PAYMENTS.md')).toBe(true);
    // Every receipt route checks admin auth.
    for (const f of r.files.filter((x) => /receipts|routes/.test(x.path))) {
      if (/recordReceipt\(/.test(f.contents)) expect(f.contents).toContain('assertAdmin');
    }
  });
});

describe('infinity Zoho Books bridge', () => {
  const ZOHO: InfinityCredentials = {
    zohoDataCenter: 'in',
    zohoClientId: '1000.CLIENT',
    zohoClientSecret: 'zsecret',
    zohoRefreshToken: '1000.refresh',
    zohoOrganizationId: '60012345',
    zohoItemId: '4600000000001',
  };
  const TOKEN = { match: 'POST https://accounts.zoho.in/oauth/v2/token', body: { access_token: '1000.access', api_domain: 'https://www.zohoapis.in', expires_in: 3600 } };
  const invoice = (over: Record<string, unknown> = {}) => ({
    invoice_id: '460000000099',
    invoice_number: 'INV-000042',
    reference_number: 'ord_z_1',
    status: 'draft',
    customer_id: '460000000011',
    currency_code: 'USD',
    total: 1200,
    balance: 1200,
    payment_made: 0,
    write_off_amount: 0,
    invoice_url: 'https://books.zoho.in/SecurePayment?CInvoiceID=abc',
    ...over,
  });
  const createRoutes = () => [
    TOKEN,
    { match: /GET https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\?/, body: { code: 0, message: 'success', invoices: [] } },
    { match: /GET https:\/\/www\.zohoapis\.in\/books\/v3\/contacts\?/, body: { code: 0, message: 'success', contacts: [{ contact_id: '460000000011', contact_name: 'Globex', currency_code: 'USD', status: 'active', email: 'ap@globex.com' }] } },
    { match: /POST https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\/460000000099\/status\/sent\?/, body: { code: 0, message: 'ok' } },
    { match: /POST https:\/\/www\.zohoapis\.in\/books\/v3\/invoices\?/, status: 201, body: { code: 0, message: 'created', invoice: invoice() } },
  ];
  const zohoGw = (routes: Parameters<typeof fakeFetch>[0], extra: Partial<InfinityCredentials> = {}) => {
    const f = fakeFetch(routes);
    return { gw: infinity.create({ ...ZOHO, ...extra }, testContext('infinity', f.fetch, { extractError: infinity.extractError })) as InfinityGateway, ...f };
  };

  it('needs every INFINITY_ZOHO_* variable, and is enough on its own', () => {
    const f = fakeFetch([]);
    expect(() => infinity.create({ zohoClientId: 'x' }, testContext('infinity', f.fetch))).toThrow(/half-configured.*INFINITY_ZOHO_REFRESH_TOKEN/);
    expect(zohoGw([]).gw.mode).toBe('zoho');
  });

  it("Skydo's ZOHO_* variables never switch Infinity onto Zoho", () => {
    const c = new PaymentsClient({
      env: { PAYMENTS_MODE: 'sandbox', ZOHO_DATA_CENTER: 'in', ZOHO_CLIENT_ID: 'a', ZOHO_CLIENT_SECRET: 'b', ZOHO_REFRESH_TOKEN: 'c', ZOHO_ORGANIZATION_ID: 'd', ZOHO_ITEM_ID: 'e', INFINITY_RECEIVING_ACCOUNTS: ACCOUNTS, INFINITY_LEDGER_FILE: tempLedger() },
      logger: silentLogger,
    });
    expect((c.gateway('infinity') as InfinityGateway).mode).toBe('ledger');
  });

  it('refuses a QuickLink in Zoho mode (the invoice is the payment document) before any Zoho call', async () => {
    const { gw, requests } = zohoGw(createRoutes(), { receivingAccounts: ACCOUNTS });
    await expect(gw.createPayment({ orderRef: 'ord_z_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' }, providerOptions: { quickLinkUrl: LINK } })).rejects.toThrow(/not accepted/);
    expect(requests).toEqual([]);
  });

  it('creates the Zoho invoice with the orderRef as reference and account details in the notes, attributed to Infinity', async () => {
    const { gw, requests } = zohoGw(createRoutes(), { receivingAccounts: ACCOUNTS });
    const r = await gw.createPayment({ orderRef: 'ord_z_1', amount: 120000, currency: 'USD', customer: { email: 'ap@globex.com' } });
    const create = requests.find((q) => q.method === 'POST' && /\/books\/v3\/invoices\?/.test(q.url))!;
    const body = JSON.parse(create.body!);
    expect(body).toMatchObject({ customer_id: '460000000011', reference_number: 'ord_z_1', line_items: [{ item_id: '4600000000001', rate: 1200, quantity: 1 }] });
    expect(body.notes).toContain('ACH routing: 021000021');
    expect(requests.some((q) => q.url.includes('/status/sent'))).toBe(true);
    expect(r).toMatchObject({ provider: 'infinity', providerOrderId: '460000000099', status: 'created' });
    if (r.checkout.type !== 'manual') throw new Error('expected manual');
    expect(r.checkout.instructions).toContain('Connect > Zoho Books');
    expect(r.checkout.instructions).toContain('confirm with your first real invoice');
    expect(r.checkout.instructions).not.toMatch(/Skydo/);
    expect(requests.every((q) => !/infinityapp/.test(q.url))).toBe(true);
  });

  it('paid only when Zoho payments cover the total; write-offs never count', async () => {
    const at = (inv: Record<string, unknown>) => zohoGw([TOKEN, { match: '/books/v3/invoices/460000000099?', body: { code: 0, message: 'success', invoice: invoice(inv) } }]).gw;
    expect(await at({ status: 'paid', balance: 0, payment_made: 1200 }).verifyPayment({ orderRef: 'ord_z_1', providerOrderId: '460000000099', expectedAmount: 120000, payload: {} })).toMatchObject({ valid: true, status: 'captured', verifiedVia: 'status_api' });
    expect((await at({ status: 'paid', balance: 0, payment_made: 0, write_off_amount: 1200 }).getPaymentStatus({ orderRef: 'ord_z_1', providerOrderId: '460000000099' })).status).toBe('failed');
    expect((await at({ status: 'sent' }).getPaymentStatus({ orderRef: 'ord_z_1', providerOrderId: '460000000099' })).status).toBe('created');
    await expect(at({ reference_number: 'ord_OTHER' }).getPaymentStatus({ orderRef: 'ord_z_1', providerOrderId: '460000000099' })).rejects.toThrow(/not ord_z_1/);
  });

  it('refuses manual receipts in Zoho mode, and outstanding points to Zoho', async () => {
    const { gw } = zohoGw([]);
    await expect(gw.recordPayment({ orderRef: 'ord_z_1', receiptId: 'R', amountReceived: 1 })).rejects.toThrow(/Zoho is the record/);
    expect(gw.outstanding()).toEqual([]);
  });

  it('a broken ledger file cannot block the Zoho bridge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infinity-bad-'));
    const file = join(dir, 'ledger.json');
    writeFileSync(file, '{ not json');
    expect(() => zohoGw([], { ledgerFile: file })).not.toThrow();
    const f = fakeFetch([]);
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('infinity', f.fetch))).toThrow(/not valid JSON/);
  });
});

describe('infinity review fixes (docs/research/verification/infinity-review.md)', () => {
  it('L2: a captured order gets no new link and no new instructions', async () => {
    const { gw } = gateway();
    await gw.createPayment({ orderRef: 'ord_l2_1', amount: 100000, currency: 'USD' });
    await gw.recordPayment({ orderRef: 'ord_l2_1', receiptId: 'INF-1', amountReceived: 100000 });
    await expect(gw.createPayment({ orderRef: 'ord_l2_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } })).rejects.toThrow(/captured/);
  });

  it('L3: Skydo and Infinity can never share a ledger file', async () => {
    const file = tempLedger();
    const f = fakeFetch([]);
    const { skydo } = await import('../../src/providers/skydo/adapter.js');
    const sk = skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch));
    await sk.createPayment({ orderRef: 'ord_l3_1', amount: 100000, currency: 'USD' });
    expect(JSON.parse(readFileSync(file, 'utf8')).provider).toBe('skydo');
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('infinity', f.fetch))).toThrow(/belongs to skydo/);
    // An untagged pre-0.3.0 file with entries is Skydo's.
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ orderRef: 'x_1', amount: 1, currency: 'USD', status: 'created', amountReceived: 0, createdAt: '', updatedAt: '', receipts: [] }] }));
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('infinity', f.fetch))).toThrow(/belongs to skydo/);
    expect(() => skydo.create({ receivingAccounts: ACCOUNTS, ledgerFile: file }, testContext('skydo', f.fetch))).not.toThrow();
  });

  it('L4: Infinity Zoho errors name the INFINITY_ZOHO_* variables', () => {
    const f = fakeFetch([]);
    expect(() => infinity.create({ zohoDataCenter: 'mars', zohoClientId: 'a', zohoClientSecret: 'b', zohoRefreshToken: 'c', zohoOrganizationId: 'd', zohoItemId: 'e' }, testContext('infinity', f.fetch))).toThrow(/INFINITY_ZOHO_DATA_CENTER "mars"/);
  });

  it('L5: QuickLink-only cannot be combined with bank details or Zoho', () => {
    const f = fakeFetch([]);
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, quickLinkOnly: 'true', ledgerFile: tempLedger() }, testContext('infinity', f.fetch))).toThrow(/QuickLinks only/);
  });

  it('L6: host list refuses IPs and over-broad wildcards', () => {
    const f = fakeFetch([]);
    for (const bad of ['10.0.0.1', '*.co.in', '*.com', '*.in']) {
      expect(() => infinity.create({ receivingAccounts: ACCOUNTS, quickLinkHosts: bad, ledgerFile: tempLedger() }, testContext('infinity', f.fetch)), bad).toThrow(CONFIG_RE);
    }
    expect(() => infinity.create({ receivingAccounts: ACCOUNTS, quickLinkHosts: '*.infinityapp.in,links.example.com', ledgerFile: tempLedger() }, testContext('infinity', f.fetch))).not.toThrow();
  });

  it('L7: mock mode refuses the same phishing link the real adapter refuses', async () => {
    const mock = new PaymentsClient({ env: { PAYMENTS_MODE: 'mock' }, logger: silentLogger });
    await expect(mock.createPayment('infinity', { orderRef: 'ord_l7_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: 'https://infinityapp.in.evil.io/q' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(mock.createPayment('infinity', { orderRef: 'ord_l7_2', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } })).resolves.toMatchObject({ status: 'created' });
  });

  it('L8: through PaymentsClient a QuickLink can be attached right after creating the order', async () => {
    const c = new PaymentsClient({ env: { PAYMENTS_MODE: 'sandbox', INFINITY_RECEIVING_ACCOUNTS: ACCOUNTS, INFINITY_LEDGER_FILE: tempLedger() }, logger: silentLogger });
    await c.createPayment('infinity', { orderRef: 'ord_l8_1', amount: 100000, currency: 'USD' });
    const withLink = await c.createPayment('infinity', { orderRef: 'ord_l8_1', amount: 100000, currency: 'USD', providerOptions: { quickLinkUrl: LINK } });
    expect(withLink.checkout).toMatchObject({ url: LINK });
    const again = await c.createPayment('infinity', { orderRef: 'ord_l8_1', amount: 100000, currency: 'USD' });
    expect(again.checkout).toMatchObject({ url: LINK });
    await expect(c.createPayment('infinity', { orderRef: 'ord_l8_1', amount: 999, currency: 'USD' })).rejects.toThrow(/different amount/);
  });
});
