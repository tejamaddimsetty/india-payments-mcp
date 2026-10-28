import type { ProviderCapabilities } from '../../core/capabilities.js';
import { startCheckoutModule } from './browser.js';
import { lines, type GeneratedFile } from './shared.js';

/** Static checkout page + ES-module script. Served by the generated Express/Fastify server from public/. */
export function htmlFiles(cap: ProviderCapabilities, base = 'public'): GeneratedFile[] {
  return [
    { path: `${base}/start-checkout.js`, language: 'javascript', contents: startCheckoutModule(cap, { typescript: false, resultPath: '/checkout.html' }) },
    { path: `${base}/checkout.html`, language: 'html', contents: checkoutHtml(cap.displayName) },
  ];
}

export function checkoutHtml(displayName: string): string {
  return lines(
    `<!doctype html>`,
    `<html lang="en">`,
    `  <head>`,
    `    <meta charset="utf-8" />`,
    `    <meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `    <title>Checkout</title>`,
    `    <style>`,
    `      body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }`,
    `      button { font-size: 1rem; padding: 0.75rem 1.5rem; cursor: pointer; }`,
    `      .status { padding: 0.75rem; border-radius: 6px; background: #f2f2f2; }`,
    `    </style>`,
    `  </head>`,
    `  <body>`,
    `    <h1>Checkout</h1>`,
    `    <p>Demo order <code>demo-order-1</code>, paid with ${displayName}. The price is set on the server.</p>`,
    `    <p id="status" class="status" role="status" hidden></p>`,
    `    <button id="pay" type="button">Pay now</button>`,
    `    <!-- Stripe Payment Element mounts here (payment_intent flow only). -->`,
    `    <div id="payment-container"></div>`,
    ``,
    `    <script type="module">`,
    `      import { payForOrder } from './start-checkout.js';`,
    ``,
    `      const statusEl = document.getElementById('status');`,
    `      const button = document.getElementById('pay');`,
    `      const show = (text) => { statusEl.textContent = text; statusEl.hidden = false; };`,
    ``,
    `      // After the gateway, the server redirects back here with ?orderRef=...&status=...`,
    `      // Display only: the order was already confirmed (or not) on the server.`,
    `      const params = new URLSearchParams(location.search);`,
    `      if (params.get('status')) {`,
    `        const ok = params.get('status') === 'captured';`,
    `        show(ok ? \`Payment successful (\${params.get('orderRef')}).\` : \`Payment \${params.get('status')} (\${params.get('orderRef')}).\`);`,
    `      }`,
    ``,
    `      button.addEventListener('click', async () => {`,
    `        button.disabled = true;`,
    `        try {`,
    `          const outcome = await payForOrder('demo-order-1', { container: document.getElementById('payment-container') });`,
    `          if (outcome.kind === 'manual') show(outcome.instructions);`,
    `          if (outcome.kind === 'dismissed') show('Checkout closed. You have not been charged.');`,
    `          if (outcome.kind === 'error') show(outcome.message);`,
    `        } catch (err) {`,
    `          show(err.message);`,
    `        } finally {`,
    `          button.disabled = false;`,
    `        }`,
    `      });`,
    `    </script>`,
    `  </body>`,
    `</html>`,
    ``,
  );
}
