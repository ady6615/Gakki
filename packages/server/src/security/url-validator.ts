import { URL } from 'node:url';
import * as net from 'node:net';

/**
 * Custom error for SSRF or invalid URL attempts.
 */
export class SecurityUrlValidationError extends Error {
  constructor(message: string, public readonly url: string) {
    super(`[SECURITY] URL validation failed: ${message}`);
    this.name = 'SecurityUrlValidationError';
  }
}

/**
 * Check if an IPv4 address is in a private, loopback, or reserved range.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (!net.isIPv4(ip)) {
    // Check IPv6 loopback
    if (ip === '::1' || ip.toLowerCase() === '0:0:0:0:0:0:0:1') {
      return true;
    }
    return false;
  }

  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4) return true;

  // 127.0.0.0/8 (Loopback)
  if (parts[0] === 127) return true;

  // 10.0.0.0/8 (Private)
  if (parts[0] === 10) return true;

  // 172.16.0.0/12 (Private)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // 192.168.0.0/16 (Private)
  if (parts[0] === 192 && parts[1] === 168) return true;

  // 169.254.0.0/16 (Link-local / AWS & GCP metadata 169.254.169.254)
  if (parts[0] === 169 && parts[1] === 254) return true;

  // 0.0.0.0/8
  if (parts[0] === 0) return true;

  return false;
}

/**
 * Validate an external URL before fetching or resolving.
 * Protects against SSRF, internal network scans, and invalid protocols.
 */
export function validateExternalUrl(urlString: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SecurityUrlValidationError('Invalid URL format', urlString);
  }

  // Only allow http and https protocols
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SecurityUrlValidationError(
      `Unsupported protocol: "${parsed.protocol}". Only HTTP and HTTPS are permitted.`,
      urlString,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and internal domain names
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa')
  ) {
    throw new SecurityUrlValidationError(`Access to internal host "${hostname}" is prohibited`, urlString);
  }

  // Check direct IP addresses
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new SecurityUrlValidationError(`Access to private/reserved IP "${hostname}" is prohibited`, urlString);
    }
  }

  return parsed;
}
