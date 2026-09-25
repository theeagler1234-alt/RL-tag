// save.js — turn a Coevolution's binary buffer into a base64 string you can
// copy out, and back again. Plain base64 (no compression): weights are
// near-random floats so gzip buys almost nothing, and staying dependency
// free keeps this reliable across browsers.

export function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // avoid call-stack limits on String.fromCharCode(...bigArray)
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBuffer(b64) {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function exportCoevolution(co) {
  return bufferToBase64(co.toBuffer());
}

export function importCoevolution(co, base64) {
  co.loadBuffer(base64ToBuffer(base64));
}
