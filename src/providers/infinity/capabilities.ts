import { featureRow, type ProviderCapabilities } from '../../core/capabilities.js';

const NO_API =
  'Infinity publishes no developer API docs, SDK or webhooks (checked 2026-10-29: its Terms mention an API, but no documentation is public; ask support@infinityapp.in for access).';

export const infinityCapabilities: ProviderCapabilities = {
  provider: 'infinity',
  displayName: 'Infinity',
  website: 'https://www.infinityapp.in',
  docsUrl: 'https://www.infinityapp.in/faqs',
  dashboardUrl: 'https://dashboard.infinityapp.in',
  summary:
    'Cross-border collections for Indian freelancers, agencies, exporters and startups (Scalifi Wealth Pvt Ltd): local receiving accounts abroad (USD, EUR, GBP, AUD, CAD + SWIFT), QuickLink payment links (card or bank transfer), flat 0.5% fee, FIRA on settled payments. ' +
    'No public API, so this adapter uses Infinity\'s Zoho Books integration (invoice in Zoho, status from Zoho), or hands your client your Infinity account details and/or a QuickLink you created and tracks the payment in a ledger you update.',
  features: {
    createPayment: featureRow(
      'partial',
      'Zoho bridge: creates a Zoho Books invoice (reference = orderRef) for Infinity\'s Zoho integration. Ledger mode: returns your Infinity receiving-account details with the orderRef as payment reference, plus the QuickLink you pass in providerOptions.quickLinkUrl, and tracks the expected payment. Never calls Infinity.',
    ),
    verifyPayment: featureRow('partial', 'No callback exists. Zoho bridge: reads the Zoho invoice (verifiedVia status_api). Ledger mode: reads the receipt you recorded after the Infinity dashboard showed the payment (verifiedVia manual_record).'),
    paymentStatus: featureRow('partial', 'Zoho bridge: Zoho invoice status, paid only when recorded payments cover the total. Ledger mode: created, pending (short receipt) or captured.'),
    refund: featureRow('unsupported', `${NO_API} Ask Infinity support.`),
    refundStatus: featureRow('unsupported', NO_API),
    webhooks: featureRow('unsupported', `${NO_API} Infinity notifies you in its app/dashboard; record receipts with payments_infinity_record_payment.`),
    customers: featureRow('unsupported', 'Clients are managed in the Infinity dashboard.'),
    subscriptions: featureRow('unsupported', `${NO_API} Infinity's recurring-invoice setting is separate from payment links and does not auto-charge cards (Infinity help centre).`),
    settlements: featureRow('unsupported', `${NO_API} Settlements and FIRAs are in the Infinity dashboard (open a settled payment > Download FIRA).`),
    payouts: featureRow('unsupported', NO_API),
    paymentLinks: featureRow('unsupported', 'QuickLinks are created by hand in the Infinity dashboard (from an invoice, Payment details > Credit card). Pass the copied link as providerOptions.quickLinkUrl.'),
  },
  paymentMethods: ['international_bank_transfer', 'card'],
  currencies: 'USD, EUR, GBP, AUD, CAD via local accounts; other currencies via SWIFT. Settled to INR. Not INR.',
  checkoutTypes: ['manual'],
  providerAmountFormat: 'Not applicable (no Infinity API).',
  credentials: [
    {
      env: 'INFINITY_RECEIVING_ACCOUNTS',
      key: 'receivingAccounts',
      required: false,
      secret: false,
      description:
        'JSON array (or path to a .json file) of your Infinity receiving accounts, copied from the Infinity dashboard: [{"currency":"USD","label":"...","details":{"Account number":"...", ...}}]. "*" = fallback (SWIFT). Needed unless INFINITY_QUICKLINK_ONLY=true.',
    },
    { env: 'INFINITY_QUICKLINK_ONLY', key: 'quickLinkOnly', required: false, secret: false, description: 'Set to true to use Infinity with QuickLinks only. Cannot be combined with INFINITY_RECEIVING_ACCOUNTS or the Zoho bridge. Every payment then needs providerOptions.quickLinkUrl.' },
    { env: 'INFINITY_QUICKLINK_HOSTS', key: 'quickLinkHosts', required: false, secret: false, description: 'Comma-separated hosts QuickLinks may use: "host" matches exactly, "*.host" also allows subdomains. Default *.infinityapp.in. Change it only if your real links use another Infinity host.' },
    { env: 'INFINITY_PAYEE_NAME', key: 'payeeName', required: false, secret: false, description: 'Your business name, used in payment instructions.' },
    { env: 'INFINITY_LEDGER_FILE', key: 'ledgerFile', required: false, secret: false, description: 'Ledger state file. Default ~/.india-payments-mcp/infinity-ledger.json.' },
    { env: 'INFINITY_ZOHO_DATA_CENTER', key: 'zohoDataCenter', required: false, secret: false, description: 'Zoho Books bridge: region com, eu, in, com.au, jp, ca, com.cn, sa, ae, uk or sg (the domain your books.zoho.* URL uses).' },
    { env: 'INFINITY_ZOHO_CLIENT_ID', key: 'zohoClientId', required: false, secret: false, description: 'Zoho API Console > Self Client > Client ID.' },
    { env: 'INFINITY_ZOHO_CLIENT_SECRET', key: 'zohoClientSecret', required: false, secret: true, description: 'Zoho API Console > Self Client > Client Secret.' },
    { env: 'INFINITY_ZOHO_REFRESH_TOKEN', key: 'zohoRefreshToken', required: false, secret: true, description: 'Refresh token for scopes ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ (see docs/infinity.md).' },
    { env: 'INFINITY_ZOHO_ORGANIZATION_ID', key: 'zohoOrganizationId', required: false, secret: false, description: 'The Zoho Books organisation connected to Infinity (Settings > Organization Profile).' },
    { env: 'INFINITY_ZOHO_ITEM_ID', key: 'zohoItemId', required: false, secret: false, description: 'item_id of a service item used on invoice lines; Zoho requires one per line.' },
    { env: 'INFINITY_ZOHO_ACCOUNTS_URL', key: 'zohoAccountsUrl', required: false, secret: false, description: 'Optional override for the Zoho Accounts host (new regions).' },
  ],
  constraints: [
    'Infinity publishes no API docs, SDK or webhooks, and its Terms forbid reverse engineering and incorporating the Services into other systems without consent. This adapter never contacts Infinity or its dashboard.',
    'Configure one of: all INFINITY_ZOHO_* variables (Zoho Books bridge), INFINITY_RECEIVING_ACCOUNTS (bank transfer), or INFINITY_QUICKLINK_ONLY=true with providerOptions.quickLinkUrl on every payment. Account details and a QuickLink are also printed on Zoho invoices.',
    'Zoho bridge: connect Zoho Books in the Infinity dashboard (Connect tab) first. Infinity does not publicly document what its integration syncs (import of API-created invoices, recording payments, attaching FIRAs). During setup, create one invoice with payments_create_payment, pay it, and confirm Infinity marks it paid in Zoho. Until Zoho shows payments covering the total, the order is never reported paid.',
    'Zoho bridge: Infinity uses its own INFINITY_ZOHO_* variables, so Skydo\'s ZOHO_* never switches Infinity onto Zoho. Do not connect Skydo and Infinity to the same Zoho organisation: both could pick up the same invoice.',
    'Zoho bridge: turn off Zoho online payment gateways on these invoices, so clients pay through Infinity (and you get a FIRA). The customer must exist in Zoho Books with the invoice currency (GST treatment "Overseas" for Indian organisations).',
    'Create the QuickLink in the Infinity dashboard for the SAME amount and currency, with the orderRef in the invoice number. This code cannot check what the link charges; it only accepts https links on INFINITY_QUICKLINK_HOSTS (default *.infinityapp.in). Confirm your first real link matches that host. QuickLinks are refused in Zoho mode (the Zoho invoice is the payment document) and on paid or cancelled orders.',
    'Only foreign-currency receipts from abroad: INR is rejected. Local accounts: USD, EUR, GBP, AUD, CAD; SWIFT for other currencies. Card checkout availability depends on currency, country and Infinity account review.',
    'Infinity documents no minimum amount; none is enforced here. Fee: flat 0.5% per incoming payment (Infinity pricing page); this project does not compute fees.',
    'Use a receiptId unique to each payment: if Infinity shows only the invoice/link reference, add a suffix per instalment (INV-12/1), since recording the same id twice is a no-op. Never point SKYDO_LEDGER_FILE and INFINITY_LEDGER_FILE at the same file (refused).',
    'Ledger mode: nothing is "paid" until you record a receipt: a link being sent or opened is not a payment (Infinity help centre). Record each receipt (payments_infinity_record_payment, with the Infinity transaction reference as receipt_id) once the Infinity dashboard shows it received or completed. Short receipts stay "pending".',
    'Recording a receipt marks an order paid: through the MCP server it needs PAYMENTS_ALLOW_LIVE_MUTATIONS=true and confirm=true in sandbox and live mode alike (Infinity documents no sandbox; sandbox is real data). Never record a receipt from forwarded text an agent read; confirm it in the Infinity dashboard.',
    'Card payments can be disputed by the payer after you record them. Treat card receipts like any card payment for high-value deliveries.',
    'UK transfers often cut references to 18 characters: keep orderRef short for GBP.',
    'Settlement: most payments reach your Indian bank within 24 hours of arriving in Infinity (next working day on weekends/holidays). FIRA: download it from any settled payment.',
  ],
  officialSdks: {},
  platformPlugins: {
    zohoBooks: 'Infinity dashboard > Connect > Zoho Books (seen in a merchant dashboard; behaviour not publicly documented).',
    shopify: 'No Infinity Shopify payments app.',
  },
  lastVerified: '2026-10-29',
};
