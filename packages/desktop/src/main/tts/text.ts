// Text cleanup before speech synthesis: emojis/symbols read aloud sound
// terrible, and markdown artifacts (`*`, `#`, backticks, table pipes, link
// URLs) worse. Keeps normal Chinese/English text, numbers, everyday punctuation.

/**
 * Clean chat text for speech: emojis/symbols read aloud sound terrible, and
 * markdown artifacts (`*`, `#`, backticks, table pipes, link URLs) worse.
 */
export function cleanForSpeech(raw: string): string {
  let t = raw;
  // Fenced code blocks and inline code: reading code is worse than skipping it
  t = t.replace(/```[\s\S]*?```/g, "。");
  t = t.replace(/`([^`]*)`/g, "$1");
  // Markdown links/images: keep the label, drop the URL
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Markdown markers and table/quote decorations
  t = t.replace(/[#>*_|]+/g, "");
  t = t.replace(/-{3,}/g, "");
  // Emoji, pictographs, dingbats, arrows, geometric shapes, variation
  // selectors, ZWJ, keycaps, skin tones
  t = t.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu,
    "",
  );
  // Stray ASCII decorations and repeated punctuation
  t = t.replace(/[~^{}<>=+]+/g, "");
  t = t.replace(/([，。！？、；：,.!?；;:]){2,}/g, "$1");
  // No space before punctuation left behind by stripped symbols
  t = t.replace(/ +([，。！？、；：,.!?])/g, "$1");
  // Collapse whitespace
  t = t.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "。").replace(/。{2,}/g, "。");
  return t.trim();
}
