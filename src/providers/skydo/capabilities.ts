import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

const NO_API = 'Skydo has no developer API or webhooks (checked 2026-10-29; an API is on Skydo\'s roadmap since Dec 2025).';

export const skydoCapabilities: ProviderCapabilities = {
  provider: 'skydo',
  displayName: 'Skydo',
  website: 'https://www.skydo.com',
  docsUrl: 'https://www.skydo.com/faqs',
  dashboardUrl: 'https://dashboard.skydo.com',
  summary:
    'Cross-border collections for Indian exporters, freelancers and agencies: local receiving accounts abroad (USD, GBP, EUR, CAD, AUD, AED, SGD + SWIFT), FIRA, GST invoicing. ' +
    'No public API, so this adapter automates Skydo\'s own supported paths: its native Zoho Books integration, or your receiving-account details plus a payment ledger.',
  features: {
    createPayment: featureRow(
      'partial',
      'Zoho bridge: creates a Zoho Books invoice (reference = orderRef) that Skydo imports within ~10 min. Ledger mode: returns your Skydo receiving-account details with the orderRef as payment reference and tracks the expected payment. Never calls Skydo.',
    ),
    verifyPayment: featureRow('partial', 'No callback exists. Zoho bridge: reads the Zoho invoice Skydo marks paid (verifiedVia status_api). Ledger mode: reads the receipt you recorded (verifiedVia manual_record).'),
    paymentStatus: featureRow('partial', 'Zoho bridge: Zoho invoice status (paid/partially_paid/sent/overdue/void) plus whether Skydo attached the FIRA. Ledger mode: the local ledger.'),
    refund: featureRow('unsupported', `${NO_API} Skydo's FAQ says it cannot initiate a refund directly for settled InstaLink payments; for anything else ask Skydo support.`),
    refundStatus: featureRow('unsupported', NO_API),
    webhooks: featureRow('unsupported', `${NO_API} Skydo notifies you by email/WhatsApp; poll payments_get_status (Zoho bridge) or record receipts (ledger mode).`),
    customers: featureRow('unsupported', 'Zoho bridge uses your existing Zoho Books customers (matched by email or zohoCustomerId).'),
    subscriptions: featureRow('unsupported', `${NO_API} InstaLinks do not support recurring payments (Skydo FAQ); raise one invoice per billing period instead.`),
    settlements: featureRow('unsupported', `${NO_API} Payouts to your Indian bank and FIRAs are in the Skydo dashboard (Reports tab exports).`),
    payouts: featureRow('unsupported', NO_API),
    paymentLinks: featureRow('unsupported', 'InstaLinks can only be created in the Skydo dashboard; each link is single-use.'),
  },
  paymentMethods: ['international_bank_transfer'],
  currencies: 'USD, GBP, EUR, CAD, AUD, AED, SGD via local accounts; 32 currencies via the SWIFT account. Settled to INR. Not INR.',
  checkoutTypes: ['manual'],
  providerAmountFormat: 'Not applicable (no Skydo API). Zoho invoices use decimal major units; we convert from minor units.',
  credentials: [
    { env: 'SKYDO_RECEIVING_ACCOUNTS', key: 'receivingAccounts', required: false, secret: false, description: 'JSON array (or path to a .json file) of your receiving accounts from Skydo dashboard > International Accounts: [{"currency":"USD","label":"...","details":{"Account number":"...", ...}}]. "*" = fallback. Needed for ledger mode; also printed on Zoho invoices.' },
    { env: 'SKYDO_PAYEE_NAME', key: 'payeeName', required: false, secret: false, description: 'Your business name, used in payment instructions.' },
    { env: 'SKYDO_LEDGER_FILE', key: 'ledgerFile', required: false, secret: false, description: 'Ledger mode state file. Default ~/.india-payments-mcp/skydo-ledger.json.' },
    { env: 'ZOHO_DATA_CENTER', key: 'zohoDataCenter', required: false, secret: false, description: 'Zoho Books region: com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk or sg (the domain your books.zoho.* URL uses).' },
    { env: 'ZOHO_CLIENT_ID', key: 'zohoClientId', required: false, secret: false, description: 'Zoho API Console > Self Client > Client ID.' },
    { env: 'ZOHO_CLIENT_SECRET', key: 'zohoClientSecret', required: false, secret: true, description: 'Zoho API Console > Self Client > Client Secret.' },
    { env: 'ZOHO_REFRESH_TOKEN', key: 'zohoRefreshToken', required: false, secret: true, description: 'Refresh token for scopes ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ (see docs/skydo.md).' },
    { env: 'ZOHO_ORGANIZATION_ID', key: 'zohoOrganizationId', required: false, secret: false, description: 'Zoho Books > Settings > Organization Profile > Organization ID.' },
    { env: 'ZOHO_ITEM_ID', key: 'zohoItemId', required: false, secret: false, description: 'item_id of a service item (e.g. "Export services") used on invoice lines; Zoho requires one per line.' },
    { env: 'ZOHO_ACCOUNTS_URL', key: 'zohoAccountsUrl', required: false, secret: false, description: 'Optional override for the Zoho Accounts host (new regions).' },
  ],
  constraints: [
    'Skydo has no public API, SDK or webhooks, and its Terms of Use prohibit scrapers, bots and other automated access to the platform. This adapter never contacts Skydo.',
    'Configure at least one of: SKYDO_RECEIVING_ACCOUNTS (ledger mode) or all ZOHO_* variables (Zoho bridge). With both, Zoho invoices also carry your account details.',
    'Zoho bridge prerequisites (one-time): connect Skydo to Zoho in the Skydo dashboard (profile > Connect Skydo to Zoho); only invoices created AFTER connecting are imported; choose "all currencies" or "international only" there.',
    'Skydo documents that invoices created in Zoho sync automatically, but not whether invoices created through the Zoho API (or only sent ones) are included. During setup, create one invoice with payments_create_payment and confirm it appears in your Skydo dashboard within ~10 minutes.',
    'Zoho "paid" is trusted only when payments cover the total: write-offs (bad debt) and credit-note closures are reported as failed/unknown, never captured.',
    'Turn off Zoho online payment gateways for these invoices, or a client could pay on the Zoho invoice page outside Skydo (no FIRA).',
    'If Zoho rejects an invoice because the currency differs from your organisation base currency, pass providerOptions.exchangeRate.',
    'Zoho bridge: the customer must exist in Zoho Books with the invoice currency. Indian Zoho organisations should set GST treatment "Overseas" for foreign clients.',
    'Only foreign-currency receipts from abroad. INR is rejected. Skydo minimum is USD 50 per payment (USD 50 equivalent in other currencies; enforced for USD, noted for others).',
    'UK transfers often cut references to 18 characters: keep orderRef short for GBP invoices.',
    'Every incoming transfer must be matched to an invoice in Skydo; always give clients the orderRef as payment reference.',
    'Ledger mode cannot see payments by itself: record each receipt (payments_skydo_record_payment, with the Skydo transaction reference as receipt_id) when Skydo notifies you. Short receipts (bank fees abroad) stay "pending". The ledger file is safe to share between your app and the MCP server (file lock).',
    'Recording a receipt marks an order paid: through the MCP server in live mode it needs PAYMENTS_ALLOW_LIVE_MUTATIONS=true and confirm=true. Never record a receipt from forwarded text an agent read; confirm it in the Skydo dashboard.',
    'Fees and timelines change: see https://www.skydo.com/faqs/fees. This project does not compute Skydo fees.',
  ],
  officialSdks: {},
  platformPlugins: {
    zohoBooks: 'Native Skydo integration: Zoho invoices sync to Skydo every 10 min; Skydo marks them paid and uploads the FIRA.',
    shopify: 'No Skydo Shopify payments app.',
  },
  lastVerified: '2026-10-29',
};
