import { McpConnectorError } from "./errors.js";

/**
 * Minimal TOML reader for import preview of Codex `config.toml` content handed in explicitly by the owner.
 * Supports tables, arrays of tables, dotted and quoted keys, basic/literal (and multi-line) strings, integers,
 * floats, booleans, arrays and inline tables; date-times are kept as opaque strings. Errors carry only a line
 * number, never input text. Tables are null-prototype objects.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const BARE = /[A-Za-z0-9_-]/;
const table = (): TomlTable => Object.create(null) as TomlTable;
const isTable = (v: unknown): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseToml(text: string): TomlTable {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new McpConnectorError("import_invalid", "codex_toml:size");
  return new Reader(text.replace(/^﻿/, "")).document();
}

class Reader {
  private i = 0;
  private line = 1;
  constructor(private readonly s: string) {}

  private fail(): never { throw new McpConnectorError("import_invalid", `codex_toml:line_${this.line}`); }
  private peek(offset = 0): string { return this.s[this.i + offset] ?? ""; }
  private next(): string {
    const c = this.s[this.i++] ?? "";
    if (c === "\n") this.line++;
    return c;
  }
  private spaces(): void { while (this.peek() === " " || this.peek() === "\t") this.i++; }
  private comment(): void { if (this.peek() === "#") while (this.i < this.s.length && this.peek() !== "\n") this.i++; }
  /** Whitespace, newlines and comments (inside arrays and between statements). */
  private blank(): void {
    for (;;) {
      this.spaces();
      this.comment();
      if (this.peek() === "\n") { this.next(); continue; }
      if (this.peek() === "\r" && this.peek(1) === "\n") { this.i++; this.next(); continue; }
      return;
    }
  }
  private endOfLine(): void {
    this.spaces();
    this.comment();
    if (this.i >= this.s.length) return;
    if (this.peek() === "\r") this.i++;
    if (this.next() !== "\n") this.fail();
  }

  document(): TomlTable {
    const root = table();
    let current = root;
    for (;;) {
      this.blank();
      if (this.i >= this.s.length) return root;
      if (this.peek() === "[") {
        const array = this.peek(1) === "[";
        this.i += array ? 2 : 1;
        this.spaces();
        const path = this.key();
        this.spaces();
        if (this.next() !== "]" || (array && this.next() !== "]")) this.fail();
        this.endOfLine();
        current = array ? this.appendTable(root, path) : this.openTable(root, path);
      } else {
        const path = this.key();
        this.spaces();
        if (this.next() !== "=") this.fail();
        this.spaces();
        this.assign(current, path, this.value(0));
        this.endOfLine();
      }
    }
  }

  private walk(root: TomlTable, path: string[]): TomlTable {
    let t = root;
    for (const part of path) {
      let next = t[part];
      if (next === undefined) { next = table(); t[part] = next; }
      if (Array.isArray(next)) next = next[next.length - 1];
      if (!isTable(next)) this.fail();
      t = next;
    }
    return t;
  }
  private openTable(root: TomlTable, path: string[]): TomlTable { return this.walk(root, path); }
  private appendTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.walk(root, path.slice(0, -1));
    const last = path[path.length - 1]!;
    const existing = parent[last] ?? [];
    if (!Array.isArray(existing)) this.fail();
    const t = table();
    existing.push(t);
    parent[last] = existing;
    return t;
  }
  private assign(target: TomlTable, path: string[], value: TomlValue): void {
    const parent = this.walk(target, path.slice(0, -1));
    const last = path[path.length - 1]!;
    if (Object.hasOwn(parent, last)) this.fail();
    parent[last] = value;
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.spaces();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const start = this.i;
        while (BARE.test(this.peek())) this.i++;
        if (this.i === start) this.fail();
        parts.push(this.s.slice(start, this.i));
      }
      this.spaces();
      if (this.peek() !== ".") return parts;
      this.i++;
    }
  }

  private value(depth: number): TomlValue {
    if (depth > MAX_DEPTH) this.fail();
    const c = this.peek();
    if (c === '"') return this.s.startsWith('"""', this.i) ? this.multiBasic() : this.basicString();
    if (c === "'") return this.s.startsWith("'''", this.i) ? this.multiLiteral() : this.literalString();
    if (c === "[") return this.array(depth);
    if (c === "{") return this.inlineTable(depth);
    if (this.s.startsWith("true", this.i) && !BARE.test(this.peek(4))) { this.i += 4; return true; }
    if (this.s.startsWith("false", this.i) && !BARE.test(this.peek(5))) { this.i += 5; return false; }
    const start = this.i;
    while (/[0-9A-Za-z_:.+-]/.test(this.peek())) this.i++;
    const token = this.s.slice(start, this.i);
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(token)) return Number(token.replace(/_/g, ""));
    if (/^0x[0-9A-Fa-f_]+$|^0o[0-7_]+$|^0b[01_]+$/.test(token)) return Number(token.replace(/_/g, ""));
    if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$/.test(token)) return Number(token.replace(/_/g, ""));
    if (/^[+-]?(?:inf|nan)$/.test(token)) return Number(token.replace("inf", "Infinity").replace("nan", "NaN"));
    if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(token)) return token;
    return this.fail();
  }

  private array(depth: number): TomlValue[] {
    this.next();
    const out: TomlValue[] = [];
    for (;;) {
      this.blank();
      if (this.peek() === "]") { this.next(); return out; }
      out.push(this.value(depth + 1));
      this.blank();
      const c = this.next();
      if (c === "]") return out;
      if (c !== ",") this.fail();
    }
  }
  private inlineTable(depth: number): TomlTable {
    this.next();
    const out = table();
    this.spaces();
    if (this.peek() === "}") { this.next(); return out; }
    for (;;) {
      const path = this.key();
      this.spaces();
      if (this.next() !== "=") this.fail();
      this.spaces();
      this.assign(out, path, this.value(depth + 1));
      this.spaces();
      const c = this.next();
      if (c === "}") return out;
      if (c !== ",") this.fail();
      this.spaces();
    }
  }

  private escape(): string {
    const c = this.next();
    const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
    if (Object.hasOwn(simple, c)) return simple[c]!;
    const width = c === "u" ? 4 : c === "U" ? 8 : c === "x" ? 2 : 0;
    if (width === 0) this.fail();
    const hex = this.s.slice(this.i, this.i + width);
    if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) this.fail();
    this.i += width;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) this.fail();
    return String.fromCodePoint(code);
  }
  private basicString(): string {
    this.next();
    let out = "";
    for (;;) {
      const c = this.next();
      if (c === "" || c === "\n") this.fail();
      if (c === '"') return out;
      out += c === "\\" ? this.escape() : c;
    }
  }
  private literalString(): string {
    this.next();
    const start = this.i;
    for (;;) {
      const c = this.next();
      if (c === "" || c === "\n") this.fail();
      if (c === "'") return this.s.slice(start, this.i - 1);
    }
  }
  private multiBasic(): string {
    this.i += 3;
    if (this.peek() === "\n") this.next(); else if (this.peek() === "\r" && this.peek(1) === "\n") { this.i++; this.next(); }
    let out = "";
    for (;;) {
      if (this.s.startsWith('"""', this.i)) {
        let quotes = 3;
        while (this.peek(quotes) === '"' && quotes < 5) quotes++;
        out += '"'.repeat(quotes - 3);
        this.i += quotes;
        return out;
      }
      const c = this.next();
      if (c === "") this.fail();
      if (c !== "\\") { out += c; continue; }
      // Line-ending backslash: trims the newline and following whitespace.
      let j = this.i;
      while (this.s[j] === " " || this.s[j] === "\t") j++;
      if (this.s[j] === "\n" || (this.s[j] === "\r" && this.s[j + 1] === "\n")) {
        this.i = j;
        while (/[ \t\r\n]/.test(this.peek())) this.next();
      } else out += this.escape();
    }
  }
  private multiLiteral(): string {
    this.i += 3;
    if (this.peek() === "\n") this.next(); else if (this.peek() === "\r" && this.peek(1) === "\n") { this.i++; this.next(); }
    let out = "";
    for (;;) {
      if (this.s.startsWith("'''", this.i)) {
        let quotes = 3;
        while (this.peek(quotes) === "'" && quotes < 5) quotes++;
        out += "'".repeat(quotes - 3);
        this.i += quotes;
        return out;
      }
      const c = this.next();
      if (c === "") this.fail();
      out += c;
    }
  }
}
