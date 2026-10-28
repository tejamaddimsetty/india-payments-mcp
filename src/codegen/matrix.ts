import { FEATURE_KEYS, type ProviderCapabilities, type SupportLevel } from '../core/capabilities.js';

const ICON: Record<SupportLevel, string> = {
  supported: 'Yes',
  partial: 'Partial',
  not_implemented: 'Planned',
  unsupported: 'No',
};

/** Markdown table of feature support, generated from the capability maps (single source of truth). */
export function supportMatrixMarkdown(caps: ProviderCapabilities[]): string {
  const header = `| Feature | ${caps.map((c) => c.displayName).join(' | ')} |`;
  const sep = `|---|${caps.map(() => '---').join('|')}|`;
  const rows = FEATURE_KEYS.map((k) => `| ${k} | ${caps.map((c) => ICON[c.features[k].support]).join(' | ')} |`);
  const checkout = `| checkout | ${caps.map((c) => c.checkoutTypes.join(', ')).join(' | ')} |`;
  return [
    header,
    sep,
    ...rows,
    checkout,
    '',
    'Yes = implemented here. Partial = implemented with caveats (see capability notes). Planned = the gateway offers it, this project does not yet. No = the gateway does not offer it.',
  ].join('\n');
}
