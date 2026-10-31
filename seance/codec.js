// Float32 vectors as base64 so a phone can send a full nano model
// without a giant JSON array of decimal text.

// Example: [1.5, -2] becomes a short base64 string instead of the text "1.5,-2".
export function encodeF32(values) {
  const floats = values instanceof Float32Array ? values : new Float32Array(values);
  const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
  let binary = '';
  const size = 4096;
  for (let i = 0; i < bytes.length; i += size) {
    const slice = bytes.subarray(i, Math.min(i + size, bytes.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// Reverse of encodeF32. An empty string means "no weights yet".
export function decodeF32(encoded) {
  if (!encoded) return new Float32Array(0);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
