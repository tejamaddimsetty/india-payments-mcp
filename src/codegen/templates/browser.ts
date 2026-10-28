import type { ProviderCapabilities } from '../../core/capabilities.js';
import { lines } from './shared.js';

/**
 * Browser-side `startCheckout(created)`: turns the server's CheckoutAction into whatever the
 * gateway needs (redirect, hidden form POST, JS SDK modal, or instructions).
 *
 * Emitted as TypeScript (React / Next.js) or plain ES module JavaScript (HTML / Express static),
 * from one source: `t(...)` fragments only appear in the TypeScript flavour.
 */
type Sdk = 'razorpay' | 'cashfree' | 'stripe' | 'paytm';
const ALL_SDKS: Sdk[] = ['razorpay', 'cashfree', 'stripe', 'paytm'];

/**
 * @param cap      provider whose JS SDK branch is emitted, or `'all'` for a multi-gateway client
 *                 (used by examples/express-checkout, which switches gateways via env).
 */
export function startCheckoutModule(cap: ProviderCapabilities | 'all', opts: { typescript: boolean; resultPath: string }): string {
  const ts = opts.typescript;
  const t = (s: string) => (ts ? s : '');
  const sdks: Sdk[] = cap === 'all' ? ALL_SDKS : ([jsSdkFor(cap)].filter(Boolean) as Sdk[]);
  const displayName = cap === 'all' ? 'Multi-gateway' : cap.displayName;

  const branchFor = (sdk: Sdk) => {
    switch (sdk) {
      case 'razorpay':
        return lines(
          `    // Razorpay Standard Checkout. With callback_url set (the server passes returnUrl), Razorpay`,
          `    // POSTs the signed result straight to /api/payments/callback. Without it, our handler does.`,
          `    const options${t(': Record<string, unknown>')} = { ...action.options };`,
          `    return new Promise<CheckoutOutcome>((resolve, reject) => {`,
          `      if (!options.callback_url) {`,
          `        options.handler = (response${t(': Record<string, string>')}) => {`,
          `          postJson(callbackUrl(created.orderRef), response)`,
          `            .then((r) => { goToResult(r.orderRef ?? created.orderRef, r.status); resolve({ kind: 'navigating' }); })`,
          `            .catch(reject);`,
          `        };`,
          `      }`,
          `      options.modal = { ondismiss: () => resolve({ kind: 'dismissed' }) };`,
          `      const Razorpay = (window as any).Razorpay;`,
          `      const rzp = new Razorpay(options);`,
          `      rzp.on('payment.failed', (resp${t(': any')}) => {`,
          `        // The modal stays open so the customer can retry with another method; just log it.`,
          `        console.warn('Razorpay payment failed', resp?.error?.description);`,
          `      });`,
          `      rzp.open();`,
          `    });`,
        );
      case 'cashfree':
        return lines(
          `    // cashfree.js v3. "_self" sends the browser to the return URL (our callback) when done.`,
          `    // Checkout only opens on domains whitelisted in the Cashfree dashboard.`,
          `    const { mode, paymentSessionId } = action.options as CashfreeOptions;`,
          `    const cashfree = (window as any).Cashfree({ mode });`,
          `    const result = await cashfree.checkout({ paymentSessionId, redirectTarget: '_self' });`,
          `    if (result?.error) throw new Error(result.error.message ?? 'Cashfree checkout failed');`,
          `    return { kind: 'navigating' };`,
        );
      case 'stripe':
        return lines(
          `    // Stripe Payment Element (server used providerOptions.flow = 'payment_intent').`,
          `    // The default Stripe flow is a hosted Checkout Session, which arrives as a plain redirect.`,
          `    const { publishableKey, clientSecret, billingDetails } = action.options as StripeOptions;`,
          `    if (!opts.container) throw new Error('Pass { container } so the Stripe Payment Element has somewhere to render.');`,
          `    const stripe = (window as any).Stripe(publishableKey);`,
          `    const elements = stripe.elements({ clientSecret });`,
          `    const mount = document.createElement('div');`,
          `    const pay = document.createElement('button');`,
          `    pay.type = 'button';`,
          `    pay.textContent = 'Pay now';`,
          `    opts.container.replaceChildren(mount, pay);`,
          `    elements.create('payment', billingDetails ? { defaultValues: { billingDetails } } : {}).mount(mount);`,
          `    return new Promise<CheckoutOutcome>((resolve) => {`,
          `      pay.onclick = async () => {`,
          `        pay.disabled = true;`,
          `        // On success Stripe redirects to return_url with ?payment_intent=...; the callback verifies it.`,
          `        const { error } = await stripe.confirmPayment({`,
          `          elements,`,
          `          confirmParams: { return_url: new URL(callbackUrl(created.orderRef), location.origin).href },`,
          `        });`,
          `        if (error) { pay.disabled = false; resolve({ kind: 'error', message: error.message ?? 'Payment failed' }); }`,
          `      };`,
          `    });`,
        );
      case 'paytm':
        return lines(
          `    // Paytm JS Checkout. Paytm POSTs the CHECKSUMHASH-signed result to callbackUrl (our callback).`,
          `    const options = action.options as PaytmOptions;`,
          `    const Paytm = (window as any).Paytm;`,
          `    try {`,
          `      if (!Paytm?.CheckoutJS) throw new Error('Paytm CheckoutJS did not load');`,
          `      await new Promise<void>((resolve) => (Paytm.CheckoutJS.onLoad ? Paytm.CheckoutJS.onLoad(() => resolve()) : resolve()));`,
          `      await Paytm.CheckoutJS.init({`,
          `        root: options.root,`,
          `        flow: options.flow,`,
          `        data: options.data,`,
          `        handler: {`,
          `          notifyMerchant: (eventName${t(': string')}, data${t(': unknown')}) => console.info('Paytm event', eventName, data),`,
          `        },`,
          `      });`,
          `      Paytm.CheckoutJS.invoke();`,
          `      return { kind: 'navigating' };`,
          `    } catch (err) {`,
          `      // Same txnToken, Paytm's hosted payment page: ends at the same signed callback.`,
          `      if (!options.fallbackRedirect) throw err;`,
          `      submitForm(options.fallbackRedirect.url, options.fallbackRedirect.fields);`,
          `      return { kind: 'navigating' };`,
          `    }`,
        );
    }
  };

  // Plain JS cannot carry `as` casts / generics; strip them for the JS flavour.
  const body = (s: string) => (ts ? s : stripTs(s));

  return body(
    lines(
      `/**`,
      ` * ${displayName} checkout, browser side. Generated by india-payments-mcp.`,
      ` *`,
      ` * The server decides WHAT to pay (amount, order) and returns a CheckoutAction; this file only`,
      ` * decides HOW to show it. Nothing here is trusted: the server verifies every result.`,
      ` */`,
      ts
        ? lines(
            `export type CheckoutAction =`,
            `  | { type: 'redirect'; url: string; method: 'GET' }`,
            `  | { type: 'form_post'; url: string; fields: Record<string, string> }`,
            `  | { type: 'js_sdk'; sdk: 'razorpay' | 'cashfree' | 'stripe' | 'paytm'; scriptUrl: string; options: Record<string, unknown> }`,
            `  | { type: 'manual'; instructions: string; url?: string };`,
            ``,
            `/** Response of POST /api/payments/create. */`,
            `export interface CreatedCheckout {`,
            `  orderRef: string;`,
            `  provider: string;`,
            `  mode: 'mock' | 'sandbox' | 'live';`,
            `  amount: number;`,
            `  currency: string;`,
            `  checkout: CheckoutAction;`,
            `}`,
            ``,
            `export type CheckoutOutcome =`,
            `  | { kind: 'navigating' } // the browser is leaving for the gateway or the result page`,
            `  | { kind: 'dismissed' } // customer closed the modal`,
            `  | { kind: 'manual'; instructions: string; url?: string }`,
            `  | { kind: 'error'; message: string };`,
            ``,
            ...sdks.map(sdkOptionTypes),
            `export interface StartCheckoutOptions {`,
            `  /** Where the Stripe Payment Element renders (Stripe payment_intent flow only). */`,
            `  container?: HTMLElement;`,
            `}`,
            ``,
          )
        : lines(
            `/** @typedef {{orderRef: string, provider: string, mode: 'mock'|'sandbox'|'live', amount: number, currency: string, checkout: any}} CreatedCheckout */`,
            ``,
          ),
      `const RESULT_PATH = '${opts.resultPath}';`,
      ``,
      `/** Ask OUR server to create the payment. Send the order id only: the server prices it. */`,
      `export async function createCheckout(orderId${t(': string')})${t(': Promise<CreatedCheckout>')} {`,
      `  return postJson('/api/payments/create', { orderId });`,
      `}`,
      ``,
      `/** Create + start in one call: wire this to your Pay button. */`,
      `export async function payForOrder(orderId${t(': string')}, opts${t(': StartCheckoutOptions')} = {})${t(': Promise<CheckoutOutcome>')} {`,
      `  return startCheckout(await createCheckout(orderId), opts);`,
      `}`,
      ``,
      `export async function startCheckout(created${t(': CreatedCheckout')}, opts${t(': StartCheckoutOptions')} = {})${t(': Promise<CheckoutOutcome>')} {`,
      `  const action = created.checkout;`,
      `  switch (action.type) {`,
      `    case 'redirect':`,
      `      window.location.assign(action.url);`,
      `      return { kind: 'navigating' };`,
      ``,
      `    case 'form_post':`,
      `      // The gateway expects a top-level browser POST (not fetch): build a hidden form and submit it.`,
      `      submitForm(action.url, action.fields);`,
      `      return { kind: 'navigating' };`,
      ``,
      `    case 'manual':`,
      `      if (created.mode === 'mock') return mockCheckout(created);`,
      `      return { kind: 'manual', instructions: action.instructions, url: action.url };`,
      ``,
      `    case 'js_sdk':`,
      `      await loadScript(action.scriptUrl);`,
      ...sdks.map((sdk) => `      if (action.sdk === '${sdk}') return await ${sdk}Checkout(created, action, opts);`),
      `      throw new Error(\`Unsupported checkout SDK "\${action.sdk}" for ${displayName}\`);`,
      `  }`,
      `}`,
      ...sdks.map((sdk) =>
        lines(
          ``,
          `async function ${sdk}Checkout(`,
          `  created${t(': CreatedCheckout')},`,
          `  action${t(": Extract<CheckoutAction, { type: 'js_sdk' }>")},`,
          `  opts${t(': StartCheckoutOptions')},`,
          `)${t(': Promise<CheckoutOutcome>')} {`,
          branchFor(sdk).replace(/^ {2}/gm, ''),
          `}`,
        ),
      ),
      ``,
      `/** PAYMENTS_MODE=mock: there is no real gateway, so let the developer pick the outcome. */`,
      `async function mockCheckout(created${t(': CreatedCheckout')})${t(': Promise<CheckoutOutcome>')} {`,
      `  const success = window.confirm(\`MOCK MODE\\n\\nSimulate a SUCCESSFUL payment of \${(created.amount / 100).toFixed(2)} \${created.currency}?\\n(Cancel simulates a failure.)\`);`,
      `  const r = await postJson('/api/payments/mock-complete', { orderRef: created.orderRef, outcome: success ? 'success' : 'failure' });`,
      `  goToResult(created.orderRef, r.status);`,
      `  return { kind: 'navigating' };`,
      `}`,
      ``,
      `function callbackUrl(orderRef${t(': string')})${t(': string')} {`,
      `  return \`/api/payments/callback?orderRef=\${encodeURIComponent(orderRef)}\`;`,
      `}`,
      ``,
      `function goToResult(orderRef${t(': string')}, status${t(': string')})${t(': void')} {`,
      `  window.location.assign(\`\${RESULT_PATH}?orderRef=\${encodeURIComponent(orderRef)}&status=\${encodeURIComponent(status)}\`);`,
      `}`,
      ``,
      `function submitForm(url${t(': string')}, fields${t(': Record<string, string>')})${t(': void')} {`,
      `  const form = document.createElement('form');`,
      `  form.method = 'POST';`,
      `  form.action = url;`,
      `  form.style.display = 'none';`,
      `  for (const [name, value] of Object.entries(fields)) {`,
      `    const input = document.createElement('input');`,
      `    input.type = 'hidden';`,
      `    input.name = name;`,
      `    input.value = value;`,
      `    form.appendChild(input);`,
      `  }`,
      `  document.body.appendChild(form);`,
      `  form.submit();`,
      `}`,
      ``,
      `const loadedScripts = new Map${t('<string, Promise<void>>')}();`,
      `function loadScript(src${t(': string')})${t(': Promise<void>')} {`,
      `  let p = loadedScripts.get(src);`,
      `  if (!p) {`,
      `    p = new Promise${t('<void>')}((resolve, reject) => {`,
      `      const s = document.createElement('script');`,
      `      s.src = src;`,
      `      s.async = true;`,
      `      s.onload = () => resolve();`,
      `      s.onerror = () => { loadedScripts.delete(src); reject(new Error(\`Failed to load \${src}\`)); };`,
      `      document.head.appendChild(s);`,
      `    });`,
      `    loadedScripts.set(src, p);`,
      `  }`,
      `  return p;`,
      `}`,
      ``,
      `async function postJson(url${t(': string')}, body${t(': unknown')})${t(': Promise<any>')} {`,
      `  const res = await fetch(url, {`,
      `    method: 'POST',`,
      `    headers: { 'content-type': 'application/json', accept: 'application/json' },`,
      `    body: JSON.stringify(body),`,
      `  });`,
      `  const data = await res.json().catch(() => ({}));`,
      `  if (!res.ok) throw new Error(data.message ?? \`Request failed (\${res.status})\`);`,
      `  return data;`,
      `}`,
      ``,
    ),
  );
}

/** Which browser SDK branch this provider needs (if any), based on its capability map. */
export function jsSdkFor(cap: ProviderCapabilities): 'razorpay' | 'cashfree' | 'stripe' | 'paytm' | undefined {
  if (!cap.checkoutTypes.includes('js_sdk')) return undefined;
  const id = cap.provider;
  return id === 'razorpay' || id === 'cashfree' || id === 'stripe' || id === 'paytm' ? id : undefined;
}

/**
 * Remove the TypeScript-only constructs used in the template above. Deliberately narrow: it only
 * has to handle the handful of patterns this file writes (`as X`, `(window as any)`, `<void>`).
 */
function stripTs(src: string): string {
  return src
    .replace(/\(window as any\)/g, 'window')
    .replace(/ as [A-Za-z]+(?=[;,)])/g, '')
    .replace(/new Promise<[A-Za-z]+>/g, 'new Promise');
}

/** Shapes of CheckoutAction.options as the adapters emit them (TypeScript flavour only). */
function sdkOptionTypes(sdk: Sdk): string | false {
  switch (sdk) {
    case 'cashfree':
      return lines(`/** Options from the Cashfree adapter. paymentSessionId is publishable. */`, `type CashfreeOptions = { mode: 'sandbox' | 'production'; paymentSessionId: string };`, ``);
    case 'stripe':
      return lines(
        `/** Options from the Stripe adapter (payment_intent flow). Only the publishable key + client secret. */`,
        `type StripeOptions = { publishableKey: string; clientSecret: string; billingDetails?: Record<string, unknown>; returnUrl?: string };`,
        ``,
      );
    case 'paytm':
      return lines(
        `/** Options from the Paytm adapter: JS Checkout config plus a hosted-page fallback using the same txnToken. */`,
        `type PaytmOptions = {`,
        `  root: string;`,
        `  flow: string;`,
        `  data: Record<string, unknown>;`,
        `  fallbackRedirect?: { url: string; fields: Record<string, string> };`,
        `};`,
        ``,
      );
    default:
      return false;
  }
}
