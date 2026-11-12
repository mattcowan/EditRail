/**
 * EditRail — login URL check spec.
 *
 * The login URL check (scripts/lib/safe-base-url.js). It needs no
 * browser and opens no page.
 *
 * Like every spec in this folder, it NEVER saves a post (helpers.js).
 */
const { test, expect } = require('@playwright/test');
const { AUTH } = require('./helpers');

test.use({ storageState: AUTH });

/**
 * The rule every login in this repository shares before it types the admin
 * password (scripts/lib/safe-base-url.js, PR #36 review): plain HTTP is
 * allowed only to a local development host. No browser needed.
 */
test.describe('login URL check (scripts/lib/safe-base-url.js)', () => {
  const { isLocalHost, assertSafeBaseUrl } = require('../../scripts/lib/safe-base-url');

  test('plain HTTP is allowed only to a local host; HTTPS always; WP_ALLOW_HTTP=1 opts out', () => {
    // Local development hosts, including the wp-env default.
    ['localhost', '127.0.0.1', '::1', '[::1]', '10.0.0.5', '192.168.1.20', '172.16.0.1',
      'mysite.local', 'site.test', 'editrail', 'host.docker.internal'].forEach((h) => {
      expect(isLocalHost(h), h).toBe(true);
    });
    // Public-looking hosts, and a near miss on the private 172.16/12 range.
    ['example.com', 'wp.example.org', '8.8.8.8', '172.32.0.1', ''].forEach((h) => {
      expect(isLocalHost(h), h).toBe(false);
    });

    expect(() => assertSafeBaseUrl('http://localhost:8888', 'TOOLRAIL_URL')).not.toThrow();
    expect(() => assertSafeBaseUrl('https://wp.example.org', 'TOOLRAIL_URL')).not.toThrow();
    // The message names the variable that set the URL.
    expect(() => assertSafeBaseUrl('http://wp.example.org', 'TOOLRAIL_URL')).toThrow(/^TOOLRAIL_URL uses plain HTTP for a non-local host \(wp\.example\.org\)/);

    const before = process.env.WP_ALLOW_HTTP;
    try {
      process.env.WP_ALLOW_HTTP = '1';
      expect(() => assertSafeBaseUrl('http://wp.example.org', 'TOOLRAIL_URL')).not.toThrow();
      process.env.WP_ALLOW_HTTP = 'yes';
      expect(() => assertSafeBaseUrl('http://wp.example.org', 'TOOLRAIL_URL')).toThrow();
    } finally {
      if (before === undefined) {
        delete process.env.WP_ALLOW_HTTP;
      } else {
        process.env.WP_ALLOW_HTTP = before;
      }
    }
  });
});
