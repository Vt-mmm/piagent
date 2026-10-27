// data: URLs for image previews, shared by the composer, the running turn and
// the transcript. data: rather than blob: because the page's CSP allows images
// from 'self' and data: only. Plain .ts so attachment-intake.ts can register an
// image the moment it stages. Bounded: each entry holds a whole image.

const MAX_PREVIEWS = 24;

function remember(cache: Map<string, string>, key: string, url: string): string {
  cache.delete(key); cache.set(key, url);
  while (cache.size > MAX_PREVIEWS) cache.delete(cache.keys().next().value as string);
  return url;
}
function dataUrl(mimeType: string, dataBase64: string): string { return `data:${mimeType};base64,${dataBase64}`; }

// Staged images, by attachmentRef: the bytes were just read to upload them, so
// the preview needs no round trip.
const staged = new Map<string, string>();
export function rememberStagedPreview(attachmentRef: string, mimeType: string, dataBase64: string): void {
  remember(staged, attachmentRef, dataUrl(mimeType, dataBase64));
}
export function stagedPreviewUrl(attachmentRef: string): string | null { return staged.get(attachmentRef) ?? null; }

// Images already in the transcript, by session, message and position.
const sent = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();
export function sentPreviewUrl(key: string): string | null { return sent.get(key) ?? null; }
export function loadSentPreview(key: string, read: () => Promise<{ mimeType: string; dataBase64: string }>): Promise<string | null> {
  const known = sent.get(key);
  if (known) return Promise.resolve(known);
  let request = pending.get(key);
  if (!request) {
    request = read().then((image) => remember(sent, key, dataUrl(image.mimeType, image.dataBase64)))
      .catch(() => null).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}
