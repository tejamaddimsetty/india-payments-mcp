import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import { paytm, PAYTM_LIVE_HOST, PAYTM_STAGING_HOST, mapPaytmTxnStatus } from '../../src/providers/paytm/adapter.js';
import { calculateChecksum, generateSignature, paytmStringByParams, verifySignature } from '../../src/providers/paytm/checksum.js';
import { fakeFetch, testContext } from '../helpers.js';

const KEY = 'abcdEFGH1234!@#$'; // 16 bytes
const MID = 'TESTMID00000000001';
const creds = { mid: MID, merchantKey: KEY };

function gateway(routes: Parameters<typeof fakeFetch>[0], environment: 'sandbox' | 'live' = 'sandbox') {
  const ff = fakeFetch(routes);
  const gw = paytm.create(creds, testContext('paytm', ff.fetch, { environment, extractError: paytm.extractError }));
  return { gw, requests: ff.requests };
}

/** Parse a recorded Paytm request and check its head.signature against the exact body substring. */
function signedBody(raw: string | undefined): Record<string, unknown> {
  const text = raw ?? '';
  const m = /^\{"body":(.*),"head":(\{.*\})\}$/.exec(text);
  expect(m).not.toBeNull();
  const bodyJson = m![1]!;
  const head = JSON.parse(m![2]!) as { signature: string };
  expect(verifySignature(bodyJson, KEY, head.signature)).toBe(true);
  return JSON.parse(bodyJson) as Record<string, unknown>;
}

describe('paytm checksum', () => {
  it('round-trips string params', () => {
    const s = JSON.stringify({ mid: MID, orderId: 'ORD1' });
    const sig = generateSignature(s, KEY);
    expect(verifySignature(s, KEY, sig)).toBe(true);
  });

  it('round-trips object params, ignoring CHECKSUMHASH on verify', () => {
    const params = { ORDERID: 'ORD1', MID, TXNAMOUNT: '10.00', STATUS: 'TXN_SUCCESS' };
    const sig = generateSignature(params, KEY);
    expect(verifySignature({ ...params, CHECKSUMHASH: sig }, KEY, sig)).toBe(true);
  });

  it('rejects tampered params, wrong key and garbage checksums', () => {
    const params = { ORDERID: 'ORD1', TXNAMOUNT: '10.00' };
    const sig = generateSignature(params, KEY);
    expect(verifySignature({ ...params, TXNAMOUNT: '1000.00' }, KEY, sig)).toBe(false);
    expect(verifySignature(params, 'zzzzzzzzzzzzzzzz', sig)).toBe(false);
    expect(verifySignature(params, KEY, 'not-a-checksum')).toBe(false);
    expect(verifySignature(params, KEY, '')).toBe(false);
  });

  it('matches the official algorithm (sorted values, null handling, sha256+salt, AES-128-CBC)', async () => {
    expect(paytmStringByParams({ b: '2', a: '1', c: null, d: 'NULL' })).toBe('1|2||');
    const { createCipheriv, createHash } = await import('node:crypto');
    const salt = 'AbC=';
    const hash = createHash('sha256').update(`x|y|${salt}`).digest('hex') + salt;
    const c = createCipheriv('aes-128-cbc', Buffer.from(KEY), Buffer.from('@@@@&&&&####$$$$'));
    const expected = c.update(hash, 'binary', 'base64') + c.final('base64');
    expect(calculateChecksum('x|y', KEY, salt)).toBe(expected);
    expect(verifySignature('x|y', KEY, expected)).toBe(true);
  });

  it('uses a fresh 4-char salt each time', () => {
    expect(generateSignature('same', KEY)).not.toBe(generateSignature('same', KEY));
  });
});

describe('paytm adapter', () => {
  it('validates credentials', () => {
    const ctx = testContext('paytm', fakeFetch([]).fetch);
    expect(() => paytm.create({ mid: MID }, ctx)).toThrow(/PAYTM_MERCHANT_KEY/);
    expect(() => paytm.create({ mid: MID, merchantKey: 'short' }, ctx)).toThrow(/16/);
    const live = testContext('paytm', fakeFetch([]).fetch, { environment: 'live' });
    expect(() => paytm.create({ ...creds, website: 'WEBSTAGING' }, live)).toThrow(PaymentError);
  });

  it('createPayment sends a signed initiateTransaction and returns JS checkout + form fallback', async () => {
    const { gw, requests } = gateway([
      { match: 'initiateTransaction', body: { head: { signature: 'x' }, body: { resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' }, txnToken: 'TOKEN123' } } },
    ]);
    const res = await gw.createPayment({
      orderRef: 'ORD_1',
      amount: 49900,
      returnUrl: 'https://shop.test/paytm/callback',
      customer: { phone: '9999999999', email: 'a@b.test', name: 'Asha' },
    });
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${PAYTM_STAGING_HOST}/theia/api/v1/initiateTransaction?mid=${MID}&orderId=ORD_1`);
    expect(req.headers['content-type']).toBe('application/json');
    const body = signedBody(req.body);
    expect(body).toEqual({
      requestType: 'Payment',
      mid: MID,
      websiteName: 'WEBSTAGING',
      orderId: 'ORD_1',
      callbackUrl: 'https://shop.test/paytm/callback',
      txnAmount: { value: '499.00', currency: 'INR' },
      userInfo: { custId: 'CUST_ORD_1', mobile: '9999999999', email: 'a@b.test', firstName: 'Asha' },
    });

    expect(res.providerOrderId).toBe('ORD_1');
    expect(res.expiresAt).toBe('2026-10-28T10:15:00.000Z');
    expect(res.checkout.type).toBe('js_sdk');
    if (res.checkout.type !== 'js_sdk') return;
    expect(res.checkout.sdk).toBe('paytm');
    expect(res.checkout.scriptUrl).toBe(`${PAYTM_STAGING_HOST}/merchantpgpui/checkoutjs/merchants/${MID}.js`);
    expect(res.checkout.options).toMatchObject({
      root: '',
      flow: 'DEFAULT',
      data: { orderId: 'ORD_1', token: 'TOKEN123', tokenType: 'TXN_TOKEN', amount: '499.00' },
      fallbackRedirect: {
        type: 'form_post',
        url: `${PAYTM_STAGING_HOST}/theia/api/v1/showPaymentPage?mid=${MID}&orderId=ORD_1`,
        fields: { mid: MID, orderId: 'ORD_1', txnToken: 'TOKEN123' },
      },
    });
  });

  it('createPayment requires returnUrl and surfaces resultStatus F', async () => {
    const { gw } = gateway([
      { match: 'initiateTransaction', body: { body: { resultInfo: { resultStatus: 'F', resultCode: '2007', resultMsg: 'Txn amount is invalid' } } } },
    ]);
    await expect(gw.createPayment({ orderRef: 'O', amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.createPayment({ orderRef: 'O', amount: 100, returnUrl: 'https://x.test' })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      providerCode: '2007',
    });
  });

  it('uses live host and DEFAULT website in live mode', async () => {
    const { gw, requests } = gateway(
      [{ match: 'initiateTransaction', body: { body: { resultInfo: { resultStatus: 'S' }, txnToken: 'T' } } }],
      'live',
    );
    const res = await gw.createPayment({ orderRef: 'L1', amount: 100, returnUrl: 'https://x.test' });
    expect(requests[0]!.url.startsWith(`${PAYTM_LIVE_HOST}/theia/`)).toBe(true);
    expect(signedBody(requests[0]!.body).websiteName).toBe('DEFAULT');
    if (res.checkout.type === 'js_sdk') expect(res.checkout.scriptUrl.startsWith(PAYTM_LIVE_HOST)).toBe(true);
  });

  it('verifyPayment checks CHECKSUMHASH, order and amount', async () => {
    const { gw } = gateway([]);
    const fields: Record<string, string> = {
      MID, ORDERID: 'ORD_1', TXNID: '2026TXN1', TXNAMOUNT: '499.00', STATUS: 'TXN_SUCCESS', RESPCODE: '01', RESPMSG: 'Txn Success', BANKTXNID: 'B1',
    };
    fields.CHECKSUMHASH = generateSignature(fields, KEY);

    const ok = await gw.verifyPayment({ payload: fields, orderRef: 'ORD_1', expectedAmount: 49900 });
    expect(ok).toMatchObject({ valid: true, status: 'captured', providerPaymentId: '2026TXN1', amount: 49900, verifiedVia: 'signature' });

    expect((await gw.verifyPayment({ payload: fields, orderRef: 'OTHER' })).valid).toBe(false);
    expect((await gw.verifyPayment({ payload: fields, expectedAmount: 100 })).valid).toBe(false);
    expect((await gw.verifyPayment({ payload: { ...fields, TXNAMOUNT: '1.00' } })).reason).toBe('Checksum mismatch');
    const { CHECKSUMHASH: _c, ...noSig } = fields;
    expect((await gw.verifyPayment({ payload: noSig })).valid).toBe(false);

    const failed: Record<string, string> = { ...noSig, STATUS: 'TXN_FAILURE', RESPMSG: 'Declined' };
    failed.CHECKSUMHASH = generateSignature(failed, KEY);
    expect(await gw.verifyPayment({ payload: failed })).toMatchObject({ valid: true, status: 'failed', reason: 'Declined' });
  });

  it('maps statuses', () => {
    expect(mapPaytmTxnStatus('TXN_SUCCESS')).toBe('captured');
    expect(mapPaytmTxnStatus('TXN_FAILURE')).toBe('failed');
    expect(mapPaytmTxnStatus('PENDING')).toBe('pending');
    expect(mapPaytmTxnStatus('NO_RECORD_FOUND')).toBe('created');
    expect(mapPaytmTxnStatus('TXN_SUCCESS', 1000, 500)).toBe('partially_refunded');
    expect(mapPaytmTxnStatus('TXN_SUCCESS', 1000, 1000)).toBe('refunded');
    expect(mapPaytmTxnStatus('WHAT')).toBe('unknown');
  });

  it('getPaymentStatus posts a signed v3 order status request', async () => {
    const { gw, requests } = gateway([
      {
        match: '/v3/order/status',
        body: {
          head: { signature: 'x' },
          body: { resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' }, txnId: 'T9', orderId: 'ORD_1', txnAmount: '499.00', paymentMode: 'UPI', refundAmt: '0.00' },
        },
      },
    ]);
    const st = await gw.getPaymentStatus({ orderRef: 'ORD_1' });
    expect(requests[0]!.url).toBe(`${PAYTM_STAGING_HOST}/v3/order/status`);
    expect(signedBody(requests[0]!.body)).toEqual({ mid: MID, orderId: 'ORD_1' });
    expect(st).toMatchObject({ status: 'captured', providerPaymentId: 'T9', amount: 49900, amountRefunded: 0, method: 'upi' });
  });

  it('refund sends refId/txnId/rupee amount and maps PENDING', async () => {
    const { gw, requests } = gateway([
      { match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request was raised' }, refundId: 'R1', refId: 'RF_1', refundAmount: '100.00' } } },
    ]);
    const r = await gw.refund!({ orderRef: 'ORD_1', providerPaymentId: 'T9', refundRef: 'RF_1', amount: 10000 });
    expect(signedBody(requests[0]!.body)).toEqual({ mid: MID, txnType: 'REFUND', orderId: 'ORD_1', txnId: 'T9', refId: 'RF_1', refundAmount: '100.00' });
    expect(r).toMatchObject({ status: 'pending', providerRefundId: 'R1', amount: 10000, refundRef: 'RF_1' });
    await expect(gw.refund!({ orderRef: 'ORD_1', refundRef: 'X' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('full refund looks up the remaining amount first', async () => {
    const { gw, requests } = gateway([
      { match: '/v3/order/status', body: { body: { resultInfo: { resultStatus: 'TXN_SUCCESS' }, txnId: 'T9', orderId: 'ORD_1', txnAmount: '499.00', refundAmt: '99.00' } } },
      { match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'PENDING' }, refundId: 'R2' } } },
    ]);
    const r = await gw.refund!({ orderRef: 'ORD_1', providerPaymentId: 'T9', refundRef: 'RF_2' });
    expect(signedBody(requests[1]!.body).refundAmount).toBe('400.00');
    expect(r.amount).toBe(40000);
  });

  it('getRefundStatus posts to /v2/refund/status', async () => {
    const { gw, requests } = gateway([
      { match: '/v2/refund/status', body: { body: { resultInfo: { resultStatus: 'TXN_SUCCESS' }, refundId: 'R1', refId: 'RF_1', refundAmount: '100.00' } } },
    ]);
    const r = await gw.getRefundStatus!({ orderRef: 'ORD_1', refundRef: 'RF_1' });
    expect(signedBody(requests[0]!.body)).toEqual({ mid: MID, orderId: 'ORD_1', refId: 'RF_1' });
    expect(r).toMatchObject({ status: 'processed', providerRefundId: 'R1', amount: 10000 });
  });

  it('webhooks round-trip and reject tampering', async () => {
    const { gw } = gateway([]);
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'ORD_1', amount: 49900, providerPaymentId: 'T9' });
    const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(ev).toMatchObject({ type: 'payment.succeeded', id: 'T9:TXN_SUCCESS', orderRef: 'ORD_1', providerPaymentId: 'T9', amount: 49900, status: 'captured' });
    expect(ev.occurredAt).toBe('2026-10-28T10:00:00.000Z');

    const failed = await gw.simulateWebhook!({ type: 'payment.failed', orderRef: 'ORD_1', amount: 49900, providerPaymentId: 'T9' });
    expect(await gw.parseWebhook({ headers: failed.headers, rawBody: failed.rawBody })).toMatchObject({ type: 'payment.failed', id: 'T9:TXN_FAILURE' });

    const refund = await gw.simulateWebhook!({ type: 'refund.processed', orderRef: 'ORD_1', amount: 1000, refundRef: 'RF_1' });
    expect(await gw.parseWebhook({ headers: refund.headers, rawBody: refund.rawBody })).toMatchObject({ type: 'refund.processed', refundRef: 'RF_1', amount: 1000 });

    const tampered = sim.rawBody.replace('TXNAMOUNT=499.00', 'TXNAMOUNT=1.00');
    expect(tampered).not.toBe(sim.rawBody);
    await expect(gw.parseWebhook({ headers: sim.headers, rawBody: tampered })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('accepts flat JSON notifications too', async () => {
    const { gw } = gateway([]);
    const fields: Record<string, string> = { MID, ORDERID: 'ORD_2', TXNID: 'T2', TXNAMOUNT: '1.00', STATUS: 'PENDING' };
    fields.CHECKSUMHASH = generateSignature(fields, KEY);
    const ev = await gw.parseWebhook({ headers: { 'content-type': 'application/json' }, rawBody: JSON.stringify(fields) });
    expect(ev).toMatchObject({ type: 'payment.pending', status: 'pending', id: 'T2:PENDING' });
  });

  it('extractError reads resultInfo', () => {
    expect(paytm.extractError!({ body: { resultInfo: { resultCode: '501', resultMsg: 'System Error' } } }, 500)).toEqual({ code: '501', message: 'System Error' });
  });
});
