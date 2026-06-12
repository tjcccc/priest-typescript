import { PriestError } from '../errors/PriestError';

/**
 * A single image attached to the user turn.
 *
 * Provide exactly one of: path (local file), url (http/https), or data
 * (base64-encoded bytes). mediaType is used when path or data is provided;
 * defaults to image/jpeg.
 *
 * Not all providers support all source types. Ollama requires base64
 * (path or data); it does not accept http/https URLs. OpenAI-compatible and
 * Anthropic accept all three.
 *
 * Image context is not persisted in sessions — only the text prompt is stored.
 */
export interface ImageInput {
  path?: string;
  url?: string;
  data?: string;
  mediaType?: string;
}

export const DEFAULT_IMAGE_MEDIA_TYPE = 'image/jpeg';

/** Throw REQUEST_INVALID unless exactly one of path/url/data is set. */
export function validateImageInput(image: ImageInput): void {
  const sources = [image.path, image.url, image.data].filter(s => s != null);
  if (sources.length !== 1) {
    throw new PriestError(
      'REQUEST_INVALID',
      'ImageInput requires exactly one of: path, url, or data',
      {},
    );
  }
}
