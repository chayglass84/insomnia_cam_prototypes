// Task 4348: the OAuth and XAA wizards put URLs inside sentences ("Opened in your browser: https://…", "Found (https://…)").
// A long URL is hard to read and harder to copy inside a sentence, so the UI shows each one in its own copyable box.
// This splits a sentence into its words and its URLs. Pure, so it can be tested.

const URL_RE = /https?:\/\/[^\s)'"<>]+/g;

export interface UrlSplit {
  /** The sentence without its trailing URL (a URL in the middle of a sentence stays, so the sentence still reads). */
  text: string;
  /** Every URL in the input, in order, without trailing punctuation. */
  urls: string[];
}

const cleanUrl = (url: string) => url.replace(/[.,;:]+$/, '');

export const splitUrls = (input: string): UrlSplit => {
  const urls = (input.match(URL_RE) ?? []).map(cleanUrl);
  if (urls.length === 0) {
    return { text: input, urls };
  }
  const last = urls.at(-1)!;
  const at = input.lastIndexOf(last);
  // Only a URL that ends the sentence (optionally in parentheses, optionally followed by punctuation) is lifted out of it.
  const after = input.slice(at + last.length);
  if (!/^[\s).,;:]*$/.test(after)) {
    return { text: input, urls };
  }
  const text = input
    .slice(0, at)
    .replace(/[\s:(-]+$/, '')
    .replace(/\s+(?:at|from)$/i, '')
    .trim();
  return { text, urls };
};
