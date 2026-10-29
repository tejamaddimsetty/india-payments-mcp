import { PaymentError } from '../../core/errors.js';
import type { HttpClient } from '../../core/http.js';
import type { ProviderId } from '../../core/types.js';

/**
 * Minimal Zoho Books v3 client: just what the Zoho bridges (Skydo, Infinity) need.
 *
 * Every path, parameter and field below is taken from Zoho's official OpenAPI files
 * (https://www.zoho.com/books/api/v3/openapi-all.zip: invoices.yml, contacts.yml) and the
 * Introduction / OAuth pages (data-center hosts, `Zoho-oauthtoken` header, refresh-token grant).
 * Accounts hosts per region were checked against Zoho's live server list.
 */

/** Data center -> [Zoho Accounts host, Zoho Books API host]. The token response's api_domain wins. */
export const ZOHO_DATA_CENTERS: Record<string, { accounts: string; api: string }> = {
  com: { accounts: 'https://accounts.zoho.com', api: 'https://www.zohoapis.com' },
  eu: { accounts: 'https://accounts.zoho.eu', api: 'https://www.zohoapis.eu' },
  in: { accounts: 'https://accounts.zoho.in', api: 'https://www.zohoapis.in' },
  'com.au': { accounts: 'https://accounts.zoho.com.au', api: 'https://www.zohoapis.com.au' },
  jp: { accounts: 'https://accounts.zoho.jp', api: 'https://www.zohoapis.jp' },
  ca: { accounts: 'https://accounts.zohocloud.ca', api: 'https://www.zohoapis.ca' },
  'com.cn': { accounts: 'https://accounts.zoho.com.cn', api: 'https://www.zohoapis.com.cn' },
  sa: { accounts: 'https://accounts.zoho.sa', api: 'https://www.zohoapis.sa' },
  ae: { accounts: 'https://accounts.zoho.ae', api: 'https://www.zohoapis.ae' },
  uk: { accounts: 'https://accounts.zoho.uk', api: 'https://www.zohoapis.uk' },
  sg: { accounts: 'https://accounts.zoho.sg', api: 'https://www.zohoapis.sg' },
};

export interface ZohoConfig {
  /** Which gateway uses this client: errors are attributed to it. */
  provider: ProviderId;
  /** Env var prefix named in hints: "ZOHO_" (Skydo) or "INFINITY_ZOHO_". */
  envPrefix: string;
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
  contact_type?: string;
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
  write_off_amount?: number | string;
  credits_applied?: number | string;
  last_payment_date?: string;
  has_attachment?: boolean;
  attachment_name?: string;
  invoice_url?: string;
  date?: string;
  due_date?: string;
  created_time?: string;
}

interface ZohoEnvelope {
  code: number;
  message: string;
}

const authHint = (p: string) => `Check ${p}DATA_CENTER and that the refresh token (scopes ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ) belongs to ${p}ORGANIZATION_ID.`;

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
      throw new PaymentError('CONFIG_INVALID', `${cfg.envPrefix}DATA_CENTER "${cfg.dataCenter}" is not one of ${Object.keys(ZOHO_DATA_CENTERS).join(', ')}.`, {
        provider: this.cfg.provider,
        hint: `Use the domain your Zoho Books URL ends with (books.zoho.in -> "in"), or set ${cfg.envPrefix}ACCOUNTS_URL.`,
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
        const { data } = await this.http.request<{ access_token?: string; expires_in?: number; api_domain?: string; error?: string; error_description?: string }>({
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
        // Zoho answers HTTP 200 with {"error": ...} when it will not issue a token.
        if (!data.access_token) {
          const detail = `${data.error ?? ''} ${data.error_description ?? ''}`.trim();
          // Zoho allows only 10 access tokens per refresh token per 10 minutes.
          if (/too many|rate|limit/i.test(detail)) {
            throw new PaymentError('RATE_LIMITED', `Zoho is rate-limiting token refreshes (${detail}).`, { provider: this.cfg.provider, hint: 'Wait a few minutes; tokens are cached for an hour.' });
          }
          throw new PaymentError('AUTH', `Zoho refused the refresh token${detail ? ` (${detail})` : ''}.`, {
            provider: this.cfg.provider,
            hint: `Generate a new refresh token (Zoho API Console > Self Client) with scopes ZohoBooks.invoices.ALL,ZohoBooks.contacts.READ, and check ${this.cfg.envPrefix}DATA_CENTER.`,
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
    // Build the URL after the token: the token response can move us to another api_domain.
    const send = async () => {
      const token = await this.accessToken();
      return this.http.request<T>({
        method,
        url: `${this.apiBase}/books/v3${path}?${q}`,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        body,
        operation,
        retrySafe,
      });
    };
    let res;
    try {
      res = await send();
    } catch (err) {
      if (!(err instanceof PaymentError && err.code === 'AUTH')) throw err;
      // An expired access token is rejected (HTTP 401, code 57) before anything is processed: refresh once.
      this.token = undefined;
      try {
        res = await send();
      } catch (again) {
        if (again instanceof PaymentError && again.code === 'AUTH') {
          throw new PaymentError('AUTH', again.message, { provider: this.cfg.provider, httpStatus: again.httpStatus, providerCode: again.providerCode, providerMessage: again.providerMessage, hint: authHint(this.cfg.envPrefix) });
        }
        throw again;
      }
    }
    if (res.data.code !== 0) {
      throw new PaymentError('PROVIDER_ERROR', `Zoho Books ${operation} failed: ${res.data.message}`, {
        provider: this.cfg.provider,
        providerCode: String(res.data.code),
        providerMessage: res.data.message,
        raw: res.data,
      });
    }
    return res.data;
  }

  /**
   * GET /contacts?email= matches the PRIMARY contact person's email. We re-check the address and
   * refuse to guess between several active customers.
   */
  async findCustomerByEmail(email: string): Promise<ZohoContact | undefined> {
    const data = await this.call<ZohoEnvelope & { contacts: ZohoContact[] }>('GET', '/contacts', 'zoho_find_contact', {
      email,
      contact_type: 'customer',
    });
    const exact = data.contacts.filter((c) => (c.email ?? '').toLowerCase() === email.toLowerCase());
    const active = exact.filter((c) => c.status !== 'inactive');
    if (active.length > 1) {
      throw new PaymentError('VALIDATION', `${active.length} active Zoho Books customers use ${email}.`, {
        provider: this.cfg.provider,
        hint: 'Pass providerOptions.zohoCustomerId to choose one.',
      });
    }
    if (active.length === 0 && exact.length > 0) {
      throw new PaymentError('VALIDATION', `The Zoho Books customer for ${email} is inactive.`, { provider: this.cfg.provider, hint: 'Mark the customer active in Zoho Books.' });
    }
    return active[0];
  }

  /** GET /contacts/{contact_id} */
  async getContact(contactId: string): Promise<ZohoContact> {
    const data = await this.call<ZohoEnvelope & { contact: ZohoContact }>('GET', `/contacts/${encodeURIComponent(contactId)}`, 'zoho_get_contact');
    return data.contact;
  }

  /** Every invoice whose reference_number is exactly `reference` (the filter is a search, so we re-check), all pages. */
  async findInvoicesByReference(reference: string): Promise<ZohoInvoice[]> {
    const found: ZohoInvoice[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.call<ZohoEnvelope & { invoices: ZohoInvoice[]; page_context?: { has_more_page?: boolean } | Array<{ has_more_page?: boolean }> }>(
        'GET',
        '/invoices',
        'zoho_find_invoice',
        { reference_number: reference, per_page: '200', page: String(page) },
      );
      found.push(...data.invoices.filter((i) => i.reference_number === reference));
      const ctx = Array.isArray(data.page_context) ? data.page_context[0] : data.page_context;
      if (!ctx?.has_more_page) break;
    }
    return found;
  }

  /** The live invoice for a reference: a non-void one if any exists, else the void one. */
  async findInvoiceByReference(reference: string): Promise<ZohoInvoice | undefined> {
    const all = await this.findInvoicesByReference(reference);
    return all.find((i) => i.status !== 'void') ?? all[0];
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

  /** POST /invoices/{invoice_id}/status/void */
  async markVoid(invoiceId: string): Promise<void> {
    await this.call('POST', `/invoices/${encodeURIComponent(invoiceId)}/status/void`, 'zoho_mark_void', {}, undefined, true);
  }

  /** GET /invoices/{invoice_id}: the full record, including payment_made and write_off_amount. */
  async getInvoice(invoiceId: string): Promise<ZohoInvoice> {
    const data = await this.call<ZohoEnvelope & { invoice: ZohoInvoice }>('GET', `/invoices/${encodeURIComponent(invoiceId)}`, 'zoho_get_invoice');
    return data.invoice;
  }
}
