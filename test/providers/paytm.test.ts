import { describe, expect, it } from 'vitest';
import { PaymentError } from '../../src/core/errors.js';
import {
  mapPaytmPaymentMode,
  mapPaytmTxnStatus,
  paytm,
  PAYTM_LIVE_HOST,
  PAYTM_REFUND_LIVE_HOST,
  PAYTM_REFUND_STAGING_HOST,
  PAYTM_STAGING_HOST,
  sanitizePaytmCustId,
} from '../../src/providers/paytm/adapter.js';
import { calculateChecksum, extractRawJsonMember, generateSignature, paytmStringByParams, verifySignature } from '../../src/providers/paytm/checksum.js';
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

/** A Paytm JSON response whose head.signature is a real checksum over the exact body bytes. */
function signedResponse(body: unknown, key = KEY): string {
  const bodyJson = JSON.stringify(body);
  return `{"head":{"responseTimestamp":"1","version":"v1","signature":"${generateSignature(bodyJson, key)}"},"body":${bodyJson}}`;
}

/** A signed refund webhook in the documented {head, body} shape. */
function refundWebhook(body: Record<string, unknown>, opts: { sign?: boolean; pretty?: boolean } = {}): string {
  const bodyJson = opts.pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body);
  const head = opts.sign === false ? '{"version":"v1"}' : `{"signature":"${generateSignature(bodyJson, KEY)}","version":"v1"}`;
  return opts.pretty ? `{\n  "head": ${head},\n  "body": ${bodyJson}\n}` : `{"head":${head},"body":${bodyJson}}`;
}

describe('paytm extractRawJsonMember', () => {
  it('returns the exact source text of a top-level member', () => {
    const raw = '{ "head" : {"signature":"a}b\\"c{"} ,\n "body" :{"x":"}{\\"","y":[1,{"z":"]"}],"n":null}\n}';
    expect(extractRawJsonMember(raw, 'body')).toBe('{"x":"}{\\"","y":[1,{"z":"]"}],"n":null}');
    expect(extractRawJsonMember(raw, 'head')).toBe('{"signature":"a}b\\"c{"}');
    expect(extractRawJsonMember(raw, 'missing')).toBeUndefined();
  });

  it('ignores nested "body" keys and handles primitives before it', () => {
    const raw = '{"n":12,"t":true,"head":{"body":{"fake":1}},"body":{"real":1}}';
    expect(extractRawJsonMember(raw, 'body')).toBe('{"real":1}');
  });

  it('returns undefined for non-objects and truncated input', () => {
    expect(extractRawJsonMember('[1,2]', 'body')).toBeUndefined();
    expect(extractRawJsonMember('{"body":{"a":"b"', 'body')).toBeUndefined();
    expect(extractRawJsonMember('', 'body')).toBeUndefined();
  });
});

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
      { match: 'initiateTransaction', body: signedResponse({ resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' }, txnToken: 'TOKEN123' }) },
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

  it('treats initiate resultCode 2005 (invalid checksum) as AUTH (M7)', async () => {
    const { gw } = gateway([
      { match: 'initiateTransaction', body: { body: { resultInfo: { resultStatus: 'F', resultCode: '2005', resultMsg: 'Checksum provided is invalid' } } } },
    ]);
    await expect(gw.createPayment({ orderRef: 'O', amount: 100, returnUrl: 'https://x.test' })).rejects.toMatchObject({ code: 'AUTH', providerCode: '2005' });
  });

  it('sanitises custId to the documented charset (M6)', async () => {
    expect(sanitizePaytmCustId('user-1 a+b@x.com')).toBe('user_1_a_b@x.com');
    expect(sanitizePaytmCustId('A1@!=_$.')).toBe('A1@!=_$.');
    const { gw, requests } = gateway([{ match: 'initiateTransaction', body: { body: { resultInfo: { resultStatus: 'S' }, txnToken: 'T' } } }]);
    await gw.createPayment({ orderRef: 'ORD-2026-1', amount: 100, returnUrl: 'https://x.test' });
    expect((signedBody(requests[0]!.body).userInfo as { custId: string }).custId).toBe('CUST_ORD_2026_1');
    await gw.createPayment({ orderRef: 'O2', amount: 100, returnUrl: 'https://x.test', customer: { id: 'cus-42' } });
    expect((signedBody(requests[1]!.body).userInfo as { custId: string }).custId).toBe('cus_42');
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
        body: signedResponse({
          resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' },
          txnId: 'T9',
          orderId: 'ORD_1',
          txnAmount: '499.00',
          paymentMode: 'UPI',
          refundAmt: '0.00',
        }),
      },
    ]);
    const st = await gw.getPaymentStatus({ orderRef: 'ORD_1' });
    expect(requests[0]!.url).toBe(`${PAYTM_STAGING_HOST}/v3/order/status`);
    expect(signedBody(requests[0]!.body)).toEqual({ mid: MID, orderId: 'ORD_1' });
    expect(st).toMatchObject({ status: 'captured', providerPaymentId: 'T9', amount: 49900, amountRefunded: 0, method: 'upi' });
  });

  it('verifies the response head.signature against the raw body (M9)', async () => {
    const good = { resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' }, txnId: 'T9', orderId: 'ORD_1', txnAmount: '499.00' };
    // Signed with a different key: present but invalid -> SIGNATURE_INVALID.
    const forged = gateway([{ match: '/v3/order/status', body: signedResponse(good, 'zzzzzzzzzzzzzzzz') }]);
    await expect(forged.gw.getPaymentStatus({ orderRef: 'ORD_1' })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    // Valid signature but the body was altered after signing.
    const tampered = signedResponse(good).replace('"499.00"', '"4.99"');
    const t = gateway([{ match: '/v3/order/status', body: tampered }]);
    await expect(t.gw.getPaymentStatus({ orderRef: 'ORD_1' })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    // Whitespace in the raw response is part of the signed bytes and must be preserved.
    const bodyJson = JSON.stringify(good, null, 2);
    const pretty = `{\n  "head": {"signature": "${generateSignature(bodyJson, KEY)}"},\n  "body": ${bodyJson}\n}`;
    const p = gateway([{ match: '/v3/order/status', body: pretty }]);
    await expect(p.gw.getPaymentStatus({ orderRef: 'ORD_1' })).resolves.toMatchObject({ status: 'captured', amount: 49900 });
    // Unsigned (some error responses) is tolerated.
    const unsigned = gateway([{ match: '/v3/order/status', body: { body: good } }]);
    await expect(unsigned.gw.getPaymentStatus({ orderRef: 'ORD_1' })).resolves.toMatchObject({ status: 'captured' });
  });

  it('status lookup errors are not reported as a failed payment (M8)', async () => {
    const st = (resultCode: string, resultMsg: string) =>
      gateway([{ match: '/v3/order/status', body: { body: { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode, resultMsg } } } }]).gw;
    await expect(st('501', 'Server Down').getPaymentStatus({ orderRef: 'O' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    await expect(st('334', 'Invalid Order ID').getPaymentStatus({ orderRef: 'O' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '334' });
    await expect(st('335', 'Mid is invalid').getPaymentStatus({ orderRef: 'O' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '335' });
    await expect(st('330', 'Checksum invalid').getPaymentStatus({ orderRef: 'O' })).rejects.toMatchObject({ code: 'AUTH' });
    await expect(st('227', 'Declined by bank').getPaymentStatus({ orderRef: 'O' })).resolves.toMatchObject({ status: 'failed', failureReason: 'Declined by bank' });
  });

  it('normalises paymentMode (M15)', () => {
    expect(mapPaytmPaymentMode('CC')).toBe('card');
    expect(mapPaytmPaymentMode('DC')).toBe('card');
    expect(mapPaytmPaymentMode('NB')).toBe('netbanking');
    expect(mapPaytmPaymentMode('PPI')).toBe('wallet');
    expect(mapPaytmPaymentMode('PAYTMCC')).toBe('paylater');
    expect(mapPaytmPaymentMode('UPI')).toBe('upi');
    expect(mapPaytmPaymentMode('BALANCE')).toBe('balance');
    expect(mapPaytmPaymentMode(undefined)).toBeUndefined();
    expect(paytm.capabilities.paymentMethods).toEqual(expect.arrayContaining(['wallet', 'paylater']));
  });

  it('refund sends refId/txnId/rupee amount and maps PENDING', async () => {
    const { gw, requests } = gateway([
      { match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request was raised' }, refundId: 'R1', refId: 'RF_1', refundAmount: '100.00' } } },
    ]);
    const r = await gw.refund!({ orderRef: 'ORD_1', providerPaymentId: 'T9', refundRef: 'RF_1', amount: 10000 });
    expect(requests[0]!.url).toBe(`${PAYTM_REFUND_STAGING_HOST}/refund/apply`);
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
    expect(requests[0]!.url).toBe(`${PAYTM_REFUND_STAGING_HOST}/v2/refund/status`);
    expect(signedBody(requests[0]!.body)).toEqual({ mid: MID, orderId: 'ORD_1', refId: 'RF_1' });
    expect(r).toMatchObject({ status: 'processed', providerRefundId: 'R1', amount: 10000 });
  });

  it('uses the documented securegw hosts for refunds, .com for status (M10)', async () => {
    expect(PAYTM_REFUND_STAGING_HOST).toBe('https://securegw-stage.paytmpayments.in');
    expect(PAYTM_REFUND_LIVE_HOST).toBe('https://securegw.paytmpayments.in');
    const { gw, requests } = gateway(
      [
        { match: '/v3/order/status', body: { body: { resultInfo: { resultStatus: 'TXN_SUCCESS' }, txnId: 'T9', orderId: 'O', txnAmount: '1.00' } } },
        { match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'PENDING' }, refundId: 'R' } } },
        { match: '/v2/refund/status', body: { body: { resultInfo: { resultStatus: 'PENDING' } } } },
      ],
      'live',
    );
    await gw.refund!({ orderRef: 'O', providerPaymentId: 'T9', refundRef: 'RF' });
    await gw.getRefundStatus!({ orderRef: 'O', refundRef: 'RF' });
    expect(requests.map((r) => r.url)).toEqual([
      `${PAYTM_LIVE_HOST}/v3/order/status`,
      `${PAYTM_REFUND_LIVE_HOST}/refund/apply`,
      `${PAYTM_REFUND_LIVE_HOST}/v2/refund/status`,
    ]);
  });

  it('validates refId length and comments length (M11)', async () => {
    const { gw, requests } = gateway([]);
    await expect(gw.refund!({ orderRef: 'O', providerPaymentId: 'T', refundRef: 'r'.repeat(51), amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.refund!({ orderRef: 'O', providerPaymentId: 'T', refundRef: '', amount: 100 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(gw.refund!({ orderRef: 'O', providerPaymentId: 'T', refundRef: 'R', amount: 100, reason: 'c'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(requests).toHaveLength(0);
  });

  it('a duplicate refId returns the existing refund instead of throwing (M12)', async () => {
    for (const code of ['617', '671', '626', '629']) {
      const { gw, requests } = gateway([
        { match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: code, resultMsg: 'Refund Already Raised' } } } },
        { match: '/v2/refund/status', body: signedResponse({ resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10' }, refId: 'RF_1', refundId: 'R1', refundAmount: '100.00' }) },
      ]);
      const r = await gw.refund!({ orderRef: 'ORD_1', providerPaymentId: 'T9', refundRef: 'RF_1', amount: 10000 });
      expect(r).toMatchObject({ status: 'processed', providerRefundId: 'R1', refundRef: 'RF_1', amount: 10000 });
      expect(requests[1]!.url).toBe(`${PAYTM_REFUND_STAGING_HOST}/v2/refund/status`);
      expect(signedBody(requests[1]!.body)).toEqual({ mid: MID, orderId: 'ORD_1', refId: 'RF_1' });
    }
    // Any other TXN_FAILURE still throws.
    const { gw } = gateway([{ match: '/refund/apply', body: { body: { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '619', resultMsg: 'Invalid refund amount' } } } }]);
    await expect(gw.refund!({ orderRef: 'O', providerPaymentId: 'T', refundRef: 'R', amount: 100 })).rejects.toMatchObject({ code: 'PROVIDER_ERROR', providerCode: '619' });
  });

  it('refund status lookup errors throw instead of reporting a failed refund (M13)', async () => {
    const rs = (resultStatus: string, resultCode: string) =>
      gateway([{ match: '/v2/refund/status', body: { body: { resultInfo: { resultStatus, resultCode, resultMsg: 'x' } } } }]).gw;
    await expect(rs('TXN_FAILURE', '631').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).rejects.toMatchObject({ code: 'NOT_FOUND', providerCode: '631' });
    await expect(rs('TXN_FAILURE', '335').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(rs('TXN_FAILURE', '600').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await expect(rs('TXN_FAILURE', '330').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).rejects.toMatchObject({ code: 'AUTH' });
    await expect(rs('PENDING', '501').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).resolves.toMatchObject({ status: 'pending' });
    await expect(rs('TXN_FAILURE', '501').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).resolves.toMatchObject({ status: 'pending' });
    await expect(rs('TXN_FAILURE', '700').getRefundStatus!({ orderRef: 'O', refundRef: 'R' })).resolves.toMatchObject({ status: 'failed' });
  });

  it('webhooks round-trip and reject tampering', async () => {
    const { gw } = gateway([]);
    const sim = await gw.simulateWebhook!({ type: 'payment.succeeded', orderRef: 'ORD_1', amount: 49900, providerPaymentId: 'T9' });
    const ev = await gw.parseWebhook({ headers: sim.headers, rawBody: sim.rawBody });
    expect(ev).toMatchObject({ type: 'payment.succeeded', id: 'T9:TXN_SUCCESS', orderRef: 'ORD_1', providerPaymentId: 'T9', amount: 49900, status: 'captured' });
    expect(ev.occurredAt).toBe('2026-10-28T10:00:00.000Z');

    const failed = await gw.simulateWebhook!({ type: 'payment.failed', orderRef: 'ORD_1', amount: 49900, providerPaymentId: 'T9' });
    expect(await gw.parseWebhook({ headers: failed.headers, rawBody: failed.rawBody })).toMatchObject({ type: 'payment.failed', id: 'T9:TXN_FAILURE' });


    const tampered = sim.rawBody.replace('TXNAMOUNT=499.00', 'TXNAMOUNT=1.00');
    expect(tampered).not.toBe(sim.rawBody);
    await expect(gw.parseWebhook({ headers: sim.headers, rawBody: tampered })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('refund webhooks: simulate emits the documented {head, body} JSON and round-trips (M14)', async () => {
    const { gw } = gateway([]);
    const refund = await gw.simulateWebhook!({ type: 'refund.processed', orderRef: 'ORD_1', amount: 1000, refundRef: 'RF_1', providerPaymentId: 'T9' });
    expect(refund.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(refund.rawBody) as { head: { signature: string }; body: Record<string, unknown> };
    expect(parsed.head.signature).toBeTruthy();
    expect(parsed.body).toMatchObject({ orderId: 'ORD_1', txnId: 'T9', refId: 'RF_1', refundAmount: '10.00', mid: MID });
    expect(verifySignature(extractRawJsonMember(refund.rawBody, 'body')!, KEY, parsed.head.signature)).toBe(true);
    const ev = await gw.parseWebhook({ headers: refund.headers, rawBody: refund.rawBody });
    expect(ev).toMatchObject({
      type: 'refund.processed',
      id: 'refund:RF_1:CREDIT_INITIATED',
      refundRef: 'RF_1',
      providerRefundId: 'SIMRFNDT9',
      providerPaymentId: 'T9',
      orderRef: 'ORD_1',
      amount: 1000,
      status: 'refunded',
      occurredAt: '2026-10-28T10:00:00.000Z',
    });
    const tampered = refund.rawBody.replace('"refundAmount":"10.00"', '"refundAmount":"99.00"');
    expect(tampered).not.toBe(refund.rawBody);
    await expect(gw.parseWebhook({ headers: refund.headers, rawBody: tampered })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('refund webhooks: Accept SUCCESS / FAILED, pretty-printed bodies, missing signature (M14)', async () => {
    const { gw } = gateway([]);
    const base = { orderId: 'ORD_1', txnId: 'T9', txnAmount: '100.00', refId: 'RF_2', refundId: 'R2', refundAmount: '30.00', totalRefundAmount: '30.00' };
    const accepted = await gw.parseWebhook({
      headers: { 'content-type': 'application/json' },
      rawBody: refundWebhook({ ...base, status: 'SUCCESS', acceptRefundTimestamp: '2026-10-28 15:30:00.0' }, { pretty: true }),
    });
    expect(accepted).toMatchObject({ type: 'refund.processed', id: 'refund:RF_2:SUCCESS', status: 'partially_refunded', amount: 3000, occurredAt: '2026-10-28T10:00:00.000Z' });

    const failed = await gw.parseWebhook({
      headers: { 'content-type': 'application/json' },
      rawBody: refundWebhook({ ...base, status: 'FAILED', rejectRefundReasonCode: '501', rejectRefundReasonMessage: 'Refund Failed' }),
    });
    expect(failed).toMatchObject({ type: 'refund.failed', id: 'refund:RF_2:FAILED', status: undefined });

    await expect(gw.parseWebhook({ headers: {}, rawBody: refundWebhook({ ...base, status: 'FAILED' }, { sign: false }) })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: {}, rawBody: refundWebhook({ ...base, mid: 'OTHERMID' }) })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await expect(gw.parseWebhook({ headers: {}, rawBody: '{"head":{"signature":"x"},"body":{' })).rejects.toMatchObject({ code: 'VALIDATION' });
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
