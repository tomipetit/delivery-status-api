const NAMED_ENTITIES: Record<string, string> = {
  copy: "©",
  reg: "®",
  trade: "™",
  yen: "¥",
  deg: "°",
  middot: "・",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(
      /&(copy|reg|trade|yen|deg|middot|hellip|mdash|ndash);/gi,
      (_, name: string) => NAMED_ENTITIES[name.toLowerCase()],
    )
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

export function htmlToStructuredText(html: string): string {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:h1|h2|h3|h4|p|div|section|article|ul|ol)>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/[\t\r]+/g, " ")
    .replace(/ *\| */g, " | ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
