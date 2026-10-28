import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const IP_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/;

// Lower-cased host name of a Host header, port removed ("[::1]:3000" -> "[::1]").
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

// DNS rebinding guard. Listening on loopback keeps the network out, not a web page: once a
// page's own domain resolves to 127.0.0.1, the browser lets it call the API, which acts with
// your GitHub token. Such a request still carries the page's domain in Host, so only the names
// of this machine are answered: loopback, HOST, and the .localhost name of a proxy such as
// portless (browsers resolve .localhost to loopback themselves, so no outside domain can rebind
// to it). A wildcard HOST opts into the local network: an IP address in Host is answered too,
// since a rebound page always sends its domain name, never an address.
export function hostGuard(host: string, proxyHostname: string | null): MiddlewareHandler {
  const configured = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const network = WILDCARD_HOSTS.has(configured);
  const allowed = new Set([...LOOPBACK_HOSTNAMES, configured.toLowerCase()]);
  if (proxyHostname?.endsWith(".localhost")) allowed.add(proxyHostname);
  return async (c, next) => {
    const header = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(header);
    if (allowed.has(hostname) || (network && IP_ADDRESS.test(hostname))) return next();
    return c.json({ error: `Host not allowed: ${header}` }, 403);
  };
}
