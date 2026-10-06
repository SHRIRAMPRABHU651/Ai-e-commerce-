import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTemplate } from '@orvia/notifications';

describe('email HTML escaping', () => {
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  it('escapes names, order numbers, carriers and messages in every template', () => {
    for (const name of ['order_confirmation', 'shipped', 'refund', 'delivered', 'custom'] as const) {
      const out = renderTemplate(name, { name: evil, orderNumber: evil, carrier: evil, trackingNumber: evil, items: evil, total: evil, amount: evil, message: evil, subject: evil, url: 'https://shop.example/o/1' } as never);
      expect(out.html, name).not.toContain('<img');
    }
  });
  it('only allows http(s) links', () => {
    const out = renderTemplate('verify_email', { url: 'javascript:alert(1)' } as never);
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('href="#"');
    expect(renderTemplate('verify_email', { url: 'https://shop.example/v?t=a&b=1' } as never).html).toContain('href="https://shop.example/v?t=a&amp;b=1"');
  });
  it('escapeHtml neutralises quotes and angle brackets', () => {
    expect(escapeHtml(evil)).toBe('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&#96;&amp;');
  });
});
