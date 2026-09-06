// jsonl.js — a framing decoder for pi's RPC event stream.
//
// docs/rpc.md is explicit about this (§Framing): "Split records on \n only... Do not use
// generic line readers that treat Unicode separators as newlines... In particular, Node
// readline is not protocol-compliant for RPC mode because it also splits on U+2028 and
// U+2029, which are valid inside JSON strings." A record containing either code point inside
// a string value would be torn into two lines by readline, and neither half would parse as
// JSON. So this module hand-rolls the three framing rules instead of reaching for readline:
//   - split on ASCII LF (\n) only — never a regex character class, which is exactly the kind
//     of "generic line reader" the protocol doc is warning about;
//   - strip one trailing CR, to tolerate a \r\n-terminated stream;
//   - buffer whatever hasn't seen its \n yet, since a chunk boundary can land mid-record.

export class JsonlDecoder {
  #buffer = '';

  /**
   * Feed one chunk of raw stream data (string or Buffer). Returns the complete, CR-stripped
   * line strings the chunk completed — zero, one, or several. Anything after the last \n is
   * held back until a future push() completes it.
   * @param {string|Buffer} chunk
   * @returns {string[]}
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = [];
    let newlineAt;
    while ((newlineAt = this.#buffer.indexOf('\n')) !== -1) {
      let line = this.#buffer.slice(0, newlineAt);
      this.#buffer = this.#buffer.slice(newlineAt + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
    }
    return lines;
  }

  /** Whatever has been pushed since the last completed line, for diagnostics only. */
  get pending() {
    return this.#buffer;
  }
}
