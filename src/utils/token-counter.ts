import { Tiktoken, encodingForModel } from 'js-tiktoken';

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = encodingForModel('gpt-4');
  }
  return encoder;
}

/**
 * Count tokens in a string using tiktoken
 */
export function countTokens(text: string): number {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  return tokens.length;
}

/**
 * Count tokens in a JSON object by stringifying it
 */
export function countJSONTokens(obj: any): number {
  const text = JSON.stringify(obj);
  return countTokens(text);
}

/**
 * Free the encoder (call on shutdown)
 * Note: js-tiktoken doesn't require manual cleanup, but we keep this for API compatibility
 */
export function freeEncoder(): void {
  encoder = null;
}
