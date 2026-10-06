import "./privacy-core.js";

export const privateUrl = globalThis.FocusFlowPrivacy.privateUrl;
export const privateNetwork = globalThis.FocusFlowPrivacy.privateNetwork;
export const publicUrl = globalThis.FocusFlowPrivacy.publicUrl;
export const sanitizeMetadata = globalThis.FocusFlowPrivacy.sanitizeMetadata;
export const protectedMeta = globalThis.FocusFlowPrivacy.protectedMeta;
export const PRIVACY_REASON = globalThis.FocusFlowPrivacy.REASON;

// Cache/mark identities stay exact (including search queries), but never store
// the clear-text query/path. Hashes are not encryption or anonymous telemetry.
export async function storageKey(key) {
  if (typeof key !== "string" || !key) return "";
  if (/^sha256:[a-f0-9]{64}$/.test(key)) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
