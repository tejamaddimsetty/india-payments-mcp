import type { ProviderCapabilities } from '../../core/capabilities.js';
import type { ProviderId } from '../../core/types.js';

/**
 * Codegen knowledge that the capability maps do not carry: how the customer comes back to the
 * merchant, which webhook events to subscribe to, and what a human has to click in each dashboard.
 *
 * Facts come from docs/research/gateway-api-facts.md. Where that file marks something UNVERIFIED,
 * the generated text says "confirm with <gateway>" instead of stating it as fact.
 */
export interface ProviderProfile {
  /**
   * How the browser returns to /api/payments/callback:
   *  - form_post: the gateway (or its JS) POSTs application/x-www-form-urlencoded fields
   *  - redirect_get: the browser is redirected with a (usually unsigned) query string
   *  - js_handler: a browser-side callback hands us JSON which our own JS POSTs to the server
   */
  returnStyle: Array<'form_post' | 'redirect_get' | 'js_handler'>;
  /** Payload field that carries our orderRef when the gateway echoes it back (fallback for the ?orderRef= we add). */
  orderRefField?: string;
  /** Webhook events to tick in the dashboard, per feature. */
  webhookEvents: { checkout: string[]; refunds: string[]; subscriptions: string[] };
  /** Dashboard checklist. `{{BASE}}` is replaced by the public base URL placeholder. */
  dashboardSteps: string[];
  /** One sentence about how this gateway's return is trusted. */
  trustNote: string;
}

const P: Record<ProviderId, ProviderProfile> = {
  razorpay: {
    returnStyle: ['form_post', 'js_handler'],
    webhookEvents: {
      checkout: ['payment.captured', 'payment.failed', 'order.paid'],
      refunds: ['refund.processed', 'refund.failed'],
      subscriptions: ['subscription.activated', 'subscription.charged', 'subscription.halted', 'subscription.cancelled'],
    },
    dashboardSteps: [
      'Switch the Dashboard to Test Mode, open Account & Settings > API Keys and generate a key pair. Copy the key id and secret into .env (the secret is shown only once).',
      'Account & Settings > Webhooks > Add New Webhook: URL {{BASE}}/api/payments/webhook, a long random secret (copy it into RAZORPAY_WEBHOOK_SECRET; it is NOT the API key secret), and the events listed below.',
      'Account & Settings > Payment Capture: turn on automatic capture, otherwise authorised payments are auto-refunded after the capture window.',
      'Account & Settings > Payment Methods: confirm UPI, cards, netbanking and wallets you want are enabled.',
      'Before go-live: finish KYC/activation, switch to Live Mode, generate live keys and create a SEPARATE live webhook (test webhooks never fire for live payments).',
    ],
    trustNote: 'Razorpay signs the return (HMAC-SHA256 of order_id|payment_id with the key secret); the SDK checks it against the order id we stored, not the one in the payload.',
  },
  payu: {
    returnStyle: ['form_post'],
    orderRefField: 'txnid',
    webhookEvents: {
      checkout: ['Successful payment', 'Failed payment'],
      refunds: ['Refund'],
      subscriptions: [],
    },
    dashboardSteps: [
      'PayU Dashboard (test mode): copy the merchant Key and Salt into .env. Test and production use different key/salt pairs.',
      'surl/furl are sent per request by the SDK (returnUrl = {{BASE}}/api/payments/callback). They must be HTTPS in production and on the website domain registered with PayU; ask PayU support to whitelist the domain if checkout rejects it.',
      'Dashboard > Webhooks: add {{BASE}}/api/payments/webhook for successful and failed payments (and refunds if used). Test-mode webhooks fire only for test transactions.',
      'Enable the payment modes you want (UPI, cards, netbanking, wallets, EMI) with your PayU account manager or in the dashboard.',
      'Before go-live: complete activation, swap to production Key/Salt and re-create the webhook on the production account.',
    ],
    trustNote: 'PayU POSTs the result to surl/furl with a SHA-512 reverse hash; the SDK recomputes it with your salt. PayU still recommends a verify_payment call before fulfilling, which the generated callback does.',
  },
  cashfree: {
    returnStyle: ['redirect_get'],
    orderRefField: 'order_id',
    webhookEvents: {
      checkout: ['PAYMENT_SUCCESS_WEBHOOK', 'PAYMENT_FAILED_WEBHOOK', 'PAYMENT_USER_DROPPED_WEBHOOK'],
      refunds: ['REFUND_STATUS_WEBHOOK'],
      subscriptions: ['SUBSCRIPTION_STATUS_CHANGED', 'SUBSCRIPTION_PAYMENT_SUCCESS', 'SUBSCRIPTION_PAYMENT_FAILED'],
    },
    dashboardSteps: [
      'Cashfree Merchant Dashboard > Developers > API Keys: generate sandbox keys and copy the App ID and Secret Key into .env. Production keys are separate.',
      'Developers > Whitelisting: whitelist the domain that serves your checkout page (cashfree.js refuses to open on other domains) and the return URL domain.',
      'Developers > Webhooks: add {{BASE}}/api/payments/webhook (webhook version 2025-01-01 or later) and select the events listed below. The webhook is signed with your client secret; there is no separate webhook secret.',
      'Payment Gateway > Payment Methods: enable the methods you need.',
      'Before go-live: finish KYC, switch to production keys and whitelist the production domain again (whitelists are per environment).',
    ],
    trustNote: 'Cashfree\'s return URL carries only an unsigned ?order_id=, so the SDK confirms through the Get Order API; the webhook (HMAC with the client secret) is the authoritative signal.',
  },
  ccavenue: {
    returnStyle: ['form_post'],
    webhookEvents: { checkout: ['Dynamic Event Notification (payment status)'], refunds: [], subscriptions: [] },
    dashboardSteps: [
      'CCAvenue M.A.R.S. dashboard > Settings > API Keys: generate the Working Key and Access Code for your website URL. They are bound to the domain you register, so register the exact domain that will POST to CCAvenue.',
      'Settings > Website / Redirect URL: make sure {{BASE}}/api/payments/callback (redirect_url and cancel_url) is on the registered domain.',
      'Whitelist your server\'s public egress IP with CCAvenue (Settings or via support). Server-to-server APIs (status, refund) fail until this is done; error 51407 means the access code/IP does not match.',
      'Optional: configure Dynamic Event Notification to {{BASE}}/api/payments/webhook. Its signing scheme is not publicly documented, so confirm the format with CCAvenue before relying on it.',
      'Ask CCAvenue which encryption kit your account uses (classic AES-128-CBC is the default this SDK implements).',
    ],
    trustNote: 'CCAvenue POSTs an encrypted encResp; successful decryption with your working key is the only integrity check, so the generated callback also calls the status API.',
  },
  paytm: {
    returnStyle: ['form_post'],
    orderRefField: 'ORDERID',
    webhookEvents: { checkout: ['Payment Notification'], refunds: ['Refund Notification'], subscriptions: [] },
    dashboardSteps: [
      'Paytm Payments Dashboard > Developer Settings > API Keys: copy the staging MID and Merchant Key into .env (production keys appear after activation).',
      'Website name is WEBSTAGING in staging and DEFAULT in production unless Paytm assigned you another value.',
      'Developer Settings > Webhook: set the Payment Notification URL (and Refund Notification URL) to {{BASE}}/api/payments/webhook.',
      'The callbackUrl is sent per transaction by the SDK ({{BASE}}/api/payments/callback); Paytm POSTs the CHECKSUMHASH-signed result there.',
      'Before go-live: switch hosts by setting PAYMENTS_MODE=live, use the production MID/key and re-enter webhook URLs on the production account.',
    ],
    trustNote: 'Paytm POSTs CHECKSUMHASH-signed form fields to the callback; the SDK verifies the checksum with your merchant key and the generated callback re-checks the order status.',
  },
  phonepe: {
    returnStyle: ['redirect_get'],
    webhookEvents: {
      checkout: ['checkout.order.completed', 'checkout.order.failed'],
      refunds: ['pg.refund.completed', 'pg.refund.failed'],
      subscriptions: [],
    },
    dashboardSteps: [
      'PhonePe Business Dashboard > Developer Settings: copy the client id, client secret and client version into .env. Sandbox credentials come from the PhonePe integration team.',
      'Developer Settings > Webhooks: create a webhook to {{BASE}}/api/payments/webhook with a username and a long random password; copy both into .env. In sandbox, ask the integration team to configure it.',
      'Subscribe to the events listed below.',
      'The redirect back to your site is unsigned. Nothing to configure, but never fulfil an order from the redirect alone; the generated callback always calls Order Status.',
      'Before go-live: request production credentials, re-create the webhook on production, and test one real low-value payment end to end.',
    ],
    trustNote: 'PhonePe\'s redirect is unsigned and its webhook Authorization header does not sign the body, so the SDK confirms every result through the Order Status API.',
  },
  stripe: {
    returnStyle: ['redirect_get', 'js_handler'],
    webhookEvents: {
      checkout: ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_intent.succeeded', 'payment_intent.payment_failed'],
      refunds: ['charge.refunded', 'refund.updated'],
      subscriptions: ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'],
    },
    dashboardSteps: [
      'Stripe accounts in India are invite-only: confirm your account is activated before planning a launch on Stripe.',
      'Developers > API keys (Test mode): copy the secret key into .env. Never expose it to the browser; only the publishable key is safe client-side.',
      'Developers > Webhooks > Add endpoint: {{BASE}}/api/payments/webhook with the events listed below. Copy the endpoint signing secret into .env. Locally, use `stripe listen --forward-to localhost:3000/api/payments/webhook` instead.',
      'Settings > Payment methods: enable cards/UPI and any international methods; exports need purpose codes and extra onboarding for non-INR currencies.',
      'Before go-live: switch to live keys and create a separate live webhook endpoint (live and test endpoints have different signing secrets).',
    ],
    trustNote: 'Stripe redirects back with ids only; the SDK retrieves the Session/PaymentIntent server-side, and the Stripe-Signature webhook is authoritative.',
  },
  skydo: {
    returnStyle: [],
    webhookEvents: { checkout: [], refunds: [], subscriptions: [] },
    dashboardSteps: [
      'Skydo dashboard: complete KYC and add the bank account where INR settlements should land.',
      'Create an InstaLink (payment link) per invoice or a reusable one per client, in the client\'s currency.',
      'Optional: connect Zoho Books (Skydo > Integrations) so invoices sync and get marked paid automatically.',
      'Download the FIRA for each received payment from the dashboard for GST/export compliance.',
    ],
    trustNote: 'Skydo has no public API or webhooks; payment confirmation is in the Skydo dashboard (or Zoho Books if connected).',
  },
};

export function profileFor(provider: ProviderId): ProviderProfile {
  return P[provider];
}

/** Dashboard steps with the base URL filled in, plus the concrete webhook events for the chosen features. */
export function dashboardStepsFor(
  cap: ProviderCapabilities,
  features: ReadonlySet<string>,
  baseUrl = 'https://YOUR_DOMAIN',
): string[] {
  const p = profileFor(cap.provider);
  const steps = p.dashboardSteps.map((s) => s.replaceAll('{{BASE}}', baseUrl));
  const events = [
    ...(features.has('webhooks') || features.has('checkout') ? p.webhookEvents.checkout : []),
    ...(features.has('refunds') ? p.webhookEvents.refunds : []),
    ...(features.has('subscriptions') ? p.webhookEvents.subscriptions : []),
  ];
  if (events.length > 0) steps.push(`Webhook events to subscribe to: ${events.join(', ')}.`);
  if (features.has('subscriptions') && cap.provider === 'razorpay') {
    steps.push('Subscriptions > Plans: create a plan and put its id (plan_...) in PAYMENTS_PLAN_ID, or let the server create one from the `plan` object.');
  }
  if (features.has('subscriptions') && cap.provider === 'stripe') {
    steps.push('Product catalog: create a recurring Price and put its id in PAYMENTS_PLAN_ID. Remember RBI e-mandate rules: pre-debit notice and AFA above Rs 15,000.');
  }
  if (cap.dashboardUrl) steps.unshift(`Open ${cap.dashboardUrl}.`);
  return steps;
}
