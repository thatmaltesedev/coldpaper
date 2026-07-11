/** Tiny DOM helpers - the whole app is hand-wired vanilla DOM. */

export function $<T extends HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  return node as T;
}

type Attrs = Record<string, string | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtHexGroups(bytes: Uint8Array): string {
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return hex.replace(/(.{4})(?=.)/g, '$1 ');
}

/** Make a stored filename safe to hand to a download attribute. */
export function safeFileName(name: string, fallback = 'restored.bin'): string {
  const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned || fallback;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
