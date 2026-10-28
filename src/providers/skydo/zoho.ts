import { PaymentError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http.js';

/**
 * Minimal Zoho Books v3 client: just what the Skydo bridge needs.
 *
 * Every path, parameter and field below is taken from Zoho's official OpenAPI files
 * (https://www.zoho.com/books/api/v3/openapi-all.zip: invoices.yml, contacts.yml) and the
 * Introduction / OAuth pages (data-center hosts, `Zoho-oauthtoken` header, refresh-token grant).
 */

/** Data center -> [Zoho Accounts host, Zoho Books API host]. */
export const ZOHO_DATA_CENTERS: Record<string, { accounts: string; api: string }> = {
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
};

export interface ZohoConfig {
  dataCenter: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  /** Optional override, e.g. a new Zoho region not listed above. */
  accountsUrl?: string;
}

export interface ZohoContact {
  contact_id: string;
  contact_name: string;
  currency_code?: string;
  email?: string;
  status?: string;
}

/** Fields of the invoice response that the bridge reads (invoices.yml `invoice-response`). */
export interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  reference_number?: string;
  status: string;
  customer_id: string;
  customer_name?: string;
  currency_code: string;
  total: number | string;
  balance: number | string;
  payment_made?: number | string;
  last_payment_date?: string;
  has_attachment?: boolean;
  attachment_name?: string;
  invoice_url?: string;
  date?: string;
  due_date?: string;
}

interface ZohoEnvelope {
  code: number;
  message: string;
}

export class ZohoBooks {
  private token?: { value: string; expiresAt: number };
  private refreshing?: Promise<string>;
  private apiBase: string;
  private readonly accountsUrl: string;

  constructor(
    private readonly cfg: ZohoConfig,
    private readonly http: HttpClient,
    private readonly now: () => Date,
  ) {
    const dc = ZOHO_DATA_CENTERS[cfg.dataCenter];
    if (!dc && !cfg.accountsUrl) {
      throw new PaymentError('CONFIG_INVALID', `ZOHO_DATA_CENTER "${cfg.dataCenter}" is not one of ${Object.keys(ZOHO_DATA_CENTERS).join(', ')}.`, {
        provider: 'skydo',
        hint: 'Use the domain your Zoho Books URL ends with (books.zoho.in -> "in"), or set ZOHO_ACCOUNTS_URL.',
      });
    }
    this.accountsUrl = (cfg.accountsUrl ?? dc!.accounts).replace(/\/+$/, '');
    this.apiBase = dc?.api ?? 'https://www.zohoapis.com';
  }

  /** Access tokens live one hour; refresh 5 minutes early, one refresh at a time. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.now().getTime()) return this.token.value;
    this.refreshing ??= (async () => {
      try {
        const { data } = await this.http.request<{ access_token?: string; expires_in?: number; api_domain?: string; error?: string }>({
          method: 'POST',
          url: `${this.accountsUrl}/oauth/v2/token`,
          body: new URLSearchParams({
            refresh_token: this.cfg.refreshToken,
            client_id: this.cfg.clientId,
            client_secret: this.cfg.clientSecret,
            grant_type: 'refresh_token',
          }),
          operation: 'zoho_refresh_token',
          retrySafe: true,
        });
        // Zoho answers HTTP 200 with {"error":"invalid_code"} for a bad or revoked refresh token.
        if (!data.access_token) {
          throw new PaymentError('AUTH', `Zoho refused the refresh token${data.error ? ` (${data.error})` : ''}.`, {
            provider: 'skydo',
            hint: 'Generate a new refresh token (Zoho API Console > Self Client) with scopes ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ, and check ZOHO_DATA_CENTER.',
          });
        }
        if (data.api_domain) this.apiBase = data.api_domain.replace(/\/+$/, '');
        this.token = { value: data.access_token, expiresAt: this.now().getTime() + (data.expires_in ?? 3600) * 1000 };
        return data.access_token;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async call<T extends ZohoEnvelope>(
    method: 'GET' | 'POST',
    path: string,
    operation: string,
    query: Record<string, string> = {},
    body?: unknown,
    retrySafe = method === 'GET',
  ): Promise<T> {
    const q = new URLSearchParams({ organization_id: this.cfg.organizationId, ...query });
    const url = `${this.apiBase}/books/v3${path}?${q}`;
    const send = async () =>
      this.http.request<T>({
        method,
        url,
        headers: { Authorization: `Zoho-oauthtoken ${await this.accessToken()}` },
        body,
        operation,
        retrySafe,
      });
    let res;
    try {
      res = await send();
    } catch (err) {
      // An expired/revoked access token is rejected before anything is processed: refresh once.
      if (err instanceof PaymentError && err.code === 'AUTH' && this.token) {
        this.token = undefined;
        res = await send();
      } else throw err;
    }
    if (res.data.code !== 0) {
      throw new PaymentError('PROVIDER_ERROR', `Zoho Books ${operation} failed: ${res.data.message}`, {
        provider: 'skydo',
        providerCode: String(res.data.code),
        providerMessage: res.data.message,
        raw: res.data,
      });
    }
    return res.data;
  }

  /** GET /contacts?email= (exact match on the primary contact person's email). */
  async findCustomerByEmail(email: string): Promise<ZohoContact | undefined> {
    const data = await this.call<ZohoEnvelope & { contacts: ZohoContact[] }>('GET', '/contacts', 'zoho_find_contact', {
      email,
      contact_type: 'customer',
    });
    return data.contacts.find((c) => c.status !== 'inactive') ?? data.contacts[0];
  }

  /** GET /contacts/{contact_id} */
  async getContact(contactId: string): Promise<ZohoContact> {
    const data = await this.call<ZohoEnvelope & { contact: ZohoContact }>('GET', `/contacts/${encodeURIComponent(contactId)}`, 'zoho_get_contact');
    return data.contact;
  }

  /** GET /invoices?reference_number= : used to make invoice creation idempotent on orderRef. */
  async findInvoiceByReference(reference: string): Promise<ZohoInvoice | undefined> {
    const data = await this.call<ZohoEnvelope & { invoices: ZohoInvoice[] }>('GET', '/invoices', 'zoho_find_invoice', { reference_number: reference });
    return data.invoices.find((i) => i.reference_number === reference && i.status !== 'void');
  }

  /** POST /invoices (required: customer_id, line_items[].item_id). */
  async createInvoice(body: Record<string, unknown>, send: boolean): Promise<ZohoInvoice> {
    const data = await this.call<ZohoEnvelope & { invoice: ZohoInvoice }>('POST', '/invoices', 'zoho_create_invoice', send ? { send: 'true' } : {}, body);
    return data.invoice;
  }

  /** POST /invoices/{invoice_id}/status/sent: "Mark a draft invoice as sent." */
  async markSent(invoiceId: string): Promise<void> {
    await this.call('POST', `/invoices/${encodeURIComponent(invoiceId)}/status/sent`, 'zoho_mark_sent', {}, undefined, true);
  }

  /** GET /invoices/{invoice_id} */
  async getInvoice(invoiceId: string): Promise<ZohoInvoice> {
    const data = await this.call<ZohoEnvelope & { invoice: ZohoInvoice }>('GET', `/invoices/${encodeURIComponent(invoiceId)}`, 'zoho_get_invoice');
    return data.invoice;
  }
}
