import { PULL_REQUEST_CACHE_VERSION } from "./pull-request-model.ts";

// Bump whenever CachedListing (pull-requests.ts) changes shape, so listing entries written
// in the old shape are never read. PR entries have their own version,
// PULL_REQUEST_CACHE_VERSION, so a PR shape change keeps listings. Version 1 cached whole
// fetch results under "pull-requests-v1".
const LISTING_CACHE_VERSION = 3;
export const LISTING_NAMESPACE = `pull-request-listing-v${LISTING_CACHE_VERSION}`;
export const PULL_REQUEST_NAMESPACE = `pull-request-v${PULL_REQUEST_CACHE_VERSION}`;

// Every namespace the cache has written, for the startup sweep. Only the current ones are
// read: a file in a retired namespace, or in a current family with another version, is
// never read again. Here rather than in pull-requests.ts, which tests replace wholesale.
export const CACHE_NAMESPACES = {
  current: [LISTING_NAMESPACE, PULL_REQUEST_NAMESPACE],
  retired: ["pull-requests-v1"],
};
