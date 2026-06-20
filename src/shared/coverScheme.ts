export const QUIETFOLIO_COVER_SCHEME = "quietfolio-cover";

export function isLocalCoverUrl(value?: string) {
  if (!value) return false;
  return value.startsWith(`${QUIETFOLIO_COVER_SCHEME}://`);
}
