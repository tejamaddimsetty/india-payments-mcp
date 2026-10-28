import { describe, expect, it } from 'vitest';
import { ccavenue, ccavenueDecrypt, ccavenueEncrypt, CCAVENUE_URLS, mapCcavenueStatus } from '../../src/providers/ccavenue/adapter.js';
import { fakeFetch, testContext } from '../helpers.js';

const MERCHANT_ID = '12345';
const ACCESS_CODE = 'AVAB00LK12AB34CDEF';
const WORKING_KEY = 'ABCDEF0123456789ABCDEF0123456789';

function gateway(routes: Parameters<typeof fakeFetch>[0] = [], environment: 'sandbox' | 'live' = 'sandbox') {
  const ff = fakeFetch(routes);
  const gw = ccavenue.create(
    { merchantId: MERCHANT_ID, accessCode: ACCESS_CODE, workingKey: WORKING_KEY },
    testContext('ccavenue', ff.fetch, { environment, extractError: ccavenue.extractError }),
  );
  return { gw, requests: ff.requests };
}

/** encResp exactly as CCAvenue would POST it to redirect_url. */
function encResp(fields: Record<string, string>, key = WORKING_KEY) {
  return ccavenueEncrypt(
    new URLSearchParams({ order_id: 'ORD1', tracking_id: '310009876543', order_status: 'Success', currency: 'INR', amount: '499.00', ...fields }).toString(),
    key,
  );
}

/** Outer DoWebTrans response: status=0&enc_response=<hex of JSON>. */
function apiResponse(json: unknown) {
  return `status=0&enc_response=${ccavenueEncrypt(JSON.stringify(json), WORKING_KEY)}`;
}

describe('ccavenue crypto', () => {
  it('matches a known answer (computed independently with openssl aes-128-cbc)', () => {
    const plain = 'merchant_id=12345&order_id=ORD1&amount=499.00';
    const known = '69a3534b6597052af8e1efd2db232cffdd18b5bc11584babc5a099b9284732748b6d8756a89f554c86145070272373df';
    expect(ccavenueEncrypt(plain, WORKING_KEY)).toBe(known);
    expect(ccavenueDecrypt(known, WORKING_KEY)).toBe(plain);
  });

  it('round-trips unicode and fails with the wrong key', () => {
    const enc = ccavenueEncrypt('billing_name=Āsha Rāo', WORKING_KEY);
    expect(ccavenueDecrypt(enc, WORKING_KEY)).toBe('billing_name=Āsha Rāo');
    expect(() => ccavenueDecrypt(enc, 'some-other-working-key-000000000')).toThrow();
  });
});

describe('ccavenue createPayment', () => {
  const base = {
    orderRef: 'ORD1',
    amount: 49900,
    returnUrl: 'https://shop.example/ccavenue/return',
    customer: { name: 'Asha', email: 'asha@example.com', phone: '9876543210' },
    metadata: { plan: 'gold' },
  };

  it('builds an encrypted form_post without touching the network', async () => {
    const { gw, requests } = gateway();
    const res = await gw.createPayment(base);
    expect(requests).toHaveLength(0);
    if (res.checkout.type !== 'form_post') throw new Error('expected form_post');
    expect(res.checkout.url).toBe('https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction');
    expect(Object.keys(res.checkout.fields).sort()).toEqual(['access_code', 'encRequest']);
    expect(res.checkout.fields.access_code).toBe(ACCESS_CODE);
    const plain = Object.fromEntries(new URLSearchParams(ccavenueDecrypt(res.checkout.fields.encRequest!, WORKING_KEY)));
    expect(plain).toEqual({
      merchant_id: MERCHANT_ID,
      order_id: 'ORD1',
      amount: '499.00',
      currency: 'INR',
      redirect_url: base.returnUrl,
      cancel_url: base.returnUrl,
      language: 'EN',
      billing_name: 'Asha',
      billing_email: 'asha@example.com',
      billing_tel: '9876543210',
      merchant_param1: 'gold',
    });
    expect(JSON.stringify(res)).not.toContain(WORKING_KEY);
  });

  it('uses the live checkout host in live mode', async () => {
    const { gw } = gateway([], 'live');
    const res = await gw.createPayment(base);
    expect(res.checkout.type === 'form_post' && res.checkout.url).toBe(CCAVENUE_URLS.live.checkout);
    expect(CCAVENUE_URLS.live.checkout).toContain('https://secure.ccavenue.com/');
  });

  it('requires returnUrl', async () => {
    const { gw } = gateway();
    await expect(gw.createPayment({ ...base, returnUrl: undefined })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('ccavenue verifyPayment', () => {
  it('decrypts encResp and maps Success', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ orderRef: 'ORD1', expectedAmount: 49900, payload: { encResp: encResp({}), orderNo: 'ORD1' } });
    expect(r).toMatchObject({ valid: true, status: 'captured', providerPaymentId: '310009876543', amount: 49900, verifiedVia: 'decryption' });
  });

  it('maps Failure / Aborted / Invalid', async () => {
    const { gw } = gateway();
    const status = async (s: string) => (await gw.verifyPayment({ payload: { encResp: encResp({ order_status: s }) } })).status;
    expect(await status('Failure')).toBe('failed');
    expect(await status('Aborted')).toBe('cancelled');
    expect(await status('Invalid')).toBe('failed');
  });

  it('rejects a payload encrypted with another key', async () => {
    const { gw } = gateway();
    const r = await gw.verifyPayment({ payload: { encResp: encResp({}, 'attacker-working-key-0000000000') } });
    expect(r.valid).toBe(false);
  });

  it('rejects a tampered ciphertext', async () => {
    const { gw } = gateway();
    const enc = encResp({});
    // Flipping a byte in the first block garbles "order_id=..." so the payload no longer parses.
    const tampered = (enc.startsWith('00') ? '01' : '00') + enc.slice(2);
    const r = await gw.verifyPayment({ payload: { encResp: tampered } });
    expect(r.valid).toBe(false);
  });

  it('rejects amount and order mismatches', async () => {
    const { gw } = gateway();
    expect((await gw.verifyPayment({ expectedAmount: 100, payload: { encResp: encResp({}) } })).reason).toMatch(/Amount mismatch/);
    expect((await gw.verifyPayment({ orderRef: 'ORD2', payload: { encResp: encResp({}) } })).valid).toBe(false);
  });
});

describe('ccavenue status mapping', () => {
  it('covers redirect and status-tracker values', () => {
    expect(mapCcavenueStatus('Successful')).toBe('captured');
    expect(mapCcavenueStatus('Unsuccessful')).toBe('failed');
    expect(mapCcavenueStatus('Awaited')).toBe('pending');
    expect(mapCcavenueStatus('Refunded')).toBe('refunded');
    expect(mapCcavenueStatus('Chargeback')).toBe('unknown');
  });
});

describe('ccavenue getPaymentStatus', () => {
  it('calls orderStatusTracker with an encrypted JSON request', async () => {
    const { gw, requests } = gateway([
      {
        match: 'POST https://apitest.ccavenue.com/apis/servlet/DoWebTrans',
        body: apiResponse({ status: 0, order_no: 'ORD1', reference_no: 310009876543, order_status: 'Successful', order_amt: 499.0, order_option_type: 'OPTUPI' }),
        headers: { 'content-type': 'text/plain' },
      },
    ]);
    const r = await gw.getPaymentStatus({ orderRef: 'ORD1' });
    expect(r).toMatchObject({ status: 'captured', amount: 49900, providerPaymentId: '310009876543', method: 'upi' });
    const body = Object.fromEntries(new URLSearchParams(requests[0]!.body));
    expect(body).toMatchObject({ access_code: ACCESS_CODE, command: 'orderStatusTracker', request_type: 'JSON', response_type: 'JSON', version: '1.2' });
    expect(JSON.parse(ccavenueDecrypt(body.enc_request!, WORKING_KEY))).toEqual({ order_no: 'ORD1' });
    expect(requests[0]!.body).not.toContain(WORKING_KEY);
  });

  it('unwraps Order_Status_Result and maps failures', async () => {
    const { gw } = gateway([
      { match: 'DoWebTrans', body: apiResponse({ Order_Status_Result: { status: 0, order_no: 'ORD1', order_status: 'Unsuccessful', order_amt: '499.00', order_bank_response: 'Declined' } }) },
    ]);
    expect(await gw.getPaymentStatus({ orderRef: 'ORD1' })).toMatchObject({ status: 'failed', failureReason: 'Declined' });
  });

  it('surfaces status=1 (e.g. IP not whitelisted) as PROVIDER_ERROR', async () => {
    const { gw } = gateway([{ match: 'DoWebTrans', body: 'status=1&enc_response=Access_code: Invalid Parameter&enc_error_code=51407' }]);
    await expect(gw.getPaymentStatus({ orderRef: 'ORD1' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '51407' });
  });

  it('uses the live API host in live mode', async () => {
    const { gw, requests } = gateway([{ match: 'api.ccavenue.com', body: apiResponse({ status: 0, order_no: 'ORD1', order_status: 'Awaited', order_amt: 1 }) }], 'live');
    expect((await gw.getPaymentStatus({ orderRef: 'ORD1' })).status).toBe('pending');
    expect(requests[0]!.url).toBe('https://api.ccavenue.com/apis/servlet/DoWebTrans');
  });
});

describe('ccavenue refund', () => {
  it('sends refundOrder with reference_no, refund_amount and refund_ref_no', async () => {
    const { gw, requests } = gateway([{ match: 'DoWebTrans', body: apiResponse({ Refund_Order_Result: { refund_status: 0, reason: '' } }) }]);
    const r = await gw.refund!({ orderRef: 'ORD1', providerPaymentId: '310009876543', refundRef: 'RF1', amount: 10000 });
    expect(r).toMatchObject({ status: 'pending', refundRef: 'RF1', amount: 10000 });
    const body = Object.fromEntries(new URLSearchParams(requests[0]!.body));
    expect(body.command).toBe('refundOrder');
    expect(JSON.parse(ccavenueDecrypt(body.enc_request!, WORKING_KEY))).toEqual({ reference_no: '310009876543', refund_amount: '100.00', refund_ref_no: 'RF1' });
  });

  it('surfaces a rejected refund', async () => {
    const { gw } = gateway([{ match: 'DoWebTrans', body: apiResponse({ Refund_Order_Result: { refund_status: 1, reason: 'Refund amount exceeds', error_code: '51303' } }) }]);
    await expect(gw.refund!({ orderRef: 'ORD1', providerPaymentId: '1', refundRef: 'RF1', amount: 100 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerMessage: 'Refund amount exceeds' });
  });
});

describe('ccavenue webhooks', () => {
  it('simulateWebhook round-trips through parseWebhook', async () => {
    const { gw } = gateway();
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'ORD1', amount: 49900, providerPaymentId: '310009876543' });
    const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(ev).toMatchObject({ provider: 'ccavenue', type: 'payment.succeeded', orderRef: 'ORD1', providerPaymentId: '310009876543', amount: 49900, occurredAt: '2026-10-28T10:00:00.000Z' });

    const failed = await gw.simulateWebhook!({ type: 'payment.failed', orderRef: 'ORD2', amount: 100 });
    expect((await gw.parseWebhook({ headers: failed.headers, rawBody: failed.rawBody })).type).toBe('payment.failed');
  });

  it('rejects a body that does not decrypt with the working key', async () => {
    const { gw } = gateway();
    const rawBody = new URLSearchParams({ encResp: encResp({}, 'attacker-working-key-0000000000') }).toString();
    await expect(gw.parseWebhook({ headers: {}, rawBody })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('refuses to simulate refund notifications', async () => {
    const { gw } = gateway();
    await expect(gw.simulateWebhook!({ type: 'refund.processed', orderRef: 'ORD1', amount: 100 })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('ccavenue module', () => {
  it('requires all three credentials', () => {
    expect(() => ccavenue.create({ merchantId: '1', accessCode: 'x' }, testContext('ccavenue', fakeFetch([]).fetch))).toThrow(/CCAVENUE_WORKING_KEY/);
  });
});
