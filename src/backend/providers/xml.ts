export interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
}

const TOKEN = /<(\/?)([A-Za-z0-9_:.-]+)([^>]*?)(\/?)>|([^<]+)/g;

function unescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A small XML reader for the AWS query API. No attributes, no mixed content. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#root", text: "", children: [] };
  const stack: XmlNode[] = [root];
  const cleaned = source
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const match of cleaned.matchAll(TOKEN)) {
    const [, closing, name, , selfClosing, text] = match;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) top.text += unescape(text.trim());
    } else if (closing) {
      if (stack.length > 1) stack.pop();
    } else {
      const node: XmlNode = { name, text: "", children: [] };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    }
  }
  return root.children[0] ?? root;
}

export function child(node: XmlNode | undefined, name: string) {
  return node?.children.find((c) => c.name === name);
}

export function childText(node: XmlNode | undefined, name: string) {
  return child(node, name)?.text || undefined;
}

/** The items of a `<fooSet><item>...</item></fooSet>` list. */
export function items(node: XmlNode | undefined, name: string): XmlNode[] {
  return child(node, name)?.children.filter((c) => c.name === "item") ?? [];
}
