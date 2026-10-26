import type { RegExpEngine } from "ajv/dist/types/index.js";

const CACHE_LIMIT = 32;
const PROGRAM_LIMIT = 256;
const UNICODE_PROGRAM_LIMIT = 64;
const SPACE = "\\t\\n\\v\\f\\r \\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}";
type State = { kind: "atom"; predicate: RegExp; next: number } | { kind: "split"; next: number; other: number } | { kind: "begin" | "end"; next: number } | { kind: "accept" };
type Program = { states: State[]; start: number };
const STATE_LIMIT = 1024;
const WORK_LIMIT = 8_000_000;
const matchers = new Map<string, Program>();
let workBudget: { remaining: number } | null = null;
/** Input-caused work exhaustion is local validation failure, never unsupported schema/quarantine. */
export class McpPatternWorkLimit extends Error { constructor() { super("MCP validation resource limit"); } }
export function consumeMcpValidationWork(units: number): void {
  if (workBudget && (workBudget.remaining -= units) < 0) throw new McpPatternWorkLimit();
}
export function withMcpPatternBudget<T>(operation: () => T): T {
  if (workBudget) return operation();
  workBudget = { remaining: WORK_LIMIT };
  try { return operation(); } finally { workBudget = null; }
}
const checkedPatterns = new Map<string, string>();
let created = 0, deleted = 0;
const refuse = (): never => { throw new Error("unsupported regular expression syntax or program budget"); };

/** Check the original ECMAScript-u syntax and the expanded program budget without executing a matcher.
 * Groups/alternation may be unquantified; nested/group repetitions, assertions, backreferences, Unicode properties,
 * empty/negated-empty classes, control/surrogate escapes and dialect-specific escapes are unsupported.
 * The exact upstream schema is retained. Dialect encoding below preserves the accepted ECMAScript-u semantics.
 */
export function checkedMcpPattern(pattern: string): string {
  const cached=checkedPatterns.get(pattern); if(cached!==undefined)return cached;
  if (pattern.length > 512) return refuse();
  new RegExp(pattern, "u"); // Syntax parsing only; never execute the backtracking matcher.
  let inClass = false, cost = 0, atomCost = 0, translated = "", grouped = false, classStart = 0;
  const atoms: { source: string; literal: string | null; repeated: boolean; expanded: number }[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (/[\ud800-\udfff]/u.test(c)) return refuse();
    if (c === "\\") {
      const escape = pattern[++i];
      if (!escape || /[1-9pPkcbB]/.test(escape)) return refuse();
      let token = `\\${escape}`;
      if (escape === "u") {
        const rest = pattern.slice(i + 1), match = /^(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/.exec(rest);
        if (!match) return refuse();
        const code = parseInt(match[1] ?? match[2]!, 16);
        if (code >= 0xd800 && code <= 0xdfff) return refuse();
        token = `\\x{${code.toString(16)}}`; i += match[0].length;
      } else if (escape === "x") { token += pattern.slice(i + 1, i + 3); i += 2; }
      else if (escape === "s") token = inClass ? SPACE : `[${SPACE}]`;
      else if (escape === "S") { if (inClass) return refuse(); token = `[^${SPACE}]`; }
      else if (escape === "0") token = "\\x{0}";
      else if (!"dDwWnrtvf\\/.*+?^$()[]{}|-".includes(escape)) return refuse();
      translated += token; atomCost = 1; cost++;
      if (!inClass) atoms.push({source:token,literal: "dDwWsS".includes(escape) ? null : escape === "u" ? String.fromCodePoint(parseInt(token.slice(3,-1),16)) : escape === "x" ? String.fromCharCode(parseInt(token.slice(2),16)) : ({n:"\n",r:"\r",t:"\t",v:"\v",f:"\f","0":"\0"} as Record<string,string>)[escape] ?? escape,repeated:false,expanded:1});
      continue;
    }
    if (c === "[" && !inClass) {
      if (pattern[i + 1] === "]" || pattern.slice(i + 1, i + 3) === "^]") return refuse();
      inClass = true; classStart=translated.length; translated += c; atomCost = 1; cost++; continue;
    }
    if (c === "]" && inClass) { inClass = false; translated += c; atoms.push({source:translated.slice(classStart),literal:null,repeated:false,expanded:1}); continue; }
    if (inClass) { if (c === "[" && ":=.".includes(pattern[i + 1] ?? " ")) return refuse(); translated += c; continue; }
    if (c === "(" && pattern[i + 1] === "?") {
      if (pattern.slice(i, i + 3) !== "(?:") return refuse();
      grouped=true; translated += "(?:"; i += 2; atomCost = 0; cost++; continue;
    }
    if (c === "(" || c === ")" || c === "|") { grouped=true; translated += c; atomCost = 0; cost++; continue; }
    if ("*+?{".includes(c)) {
      if (pattern[i - 1] === ")" || atomCost === 0) return refuse();
      atoms[atoms.length-1]!.repeated=true;
      if (c === "{") {
        const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
        if (!quantifier) return refuse();
        const count = Number(quantifier[2] === undefined ? quantifier[1] : quantifier[2] || quantifier[1]);
        if (count > PROGRAM_LIMIT) return refuse();
        atoms[atoms.length-1]!.expanded=Math.max(1,count);
        cost += Math.max(0, count - 1) * atomCost;
        translated += quantifier[0]; i += quantifier[0].length - 1;
      } else { if (c !== "?") {cost += atomCost;atoms[atoms.length-1]!.expanded=2;} translated += c; }
      if (pattern[i + 1] === "?") { translated += "?"; i++; }
      atomCost = 0;
    } else if (c === ".") { const source="[^\\n\\r\\x{2028}\\x{2029}]"; translated += source; atoms.push({source,literal:null,repeated:false,expanded:1}); atomCost = 1; cost++; }
    else if (c === "^" || c === "$") { if (c === "^" && i !== 0 || c === "$" && i !== pattern.length - 1) return refuse(); translated += c; atomCost = 0; cost++; }
    else { translated += c; atoms.push({source:c,literal:c,repeated:false,expanded:1}); atomCost = 1; cost++; }
    if (cost > PROGRAM_LIMIT) return refuse();
  }
  if (cost > PROGRAM_LIMIT) return refuse();
  // Negated/Unicode classes have a lower aggregate predicate/program admission budget.
  const complex=(source:string):boolean=>source.startsWith("[^")||/\\[DWSs]/.test(source)||/[^\x00-\x7f]/.test(source)
    || [...source.matchAll(/\\x\{([0-9a-f]+)\}/g)].some(match=>parseInt(match[1]!,16)>127);
  const unicodeWeight=(source:string):number=>source === "[^\\n\\r\\x{2028}\\x{2029}]" ? 1 : Math.max(1,Math.ceil(Buffer.byteLength(source,"utf8")/8));
  if(atoms.reduce((total,atom)=>total+(complex(atom.source)?atom.expanded*unicodeWeight(atom.source):0),0)>UNICODE_PROGRAM_LIMIT)return refuse();
  const repeats=atoms.filter(atom=>atom.repeated);
  // The supported subset remains stable. Runtime uses a bounded NFA, never a lazy DFA.
  // Bounded anchored expressions inspect at most PROGRAM_LIMIT input code points. Unbounded expressions use
  // a single repeated atom with disjoint literal separators; reject overlapping suffixes before compilation.
  if (repeats.length) {
    if (grouped || repeats.some(atom=>atom.source!==repeats[0]!.source)) return refuse();
    const first=atoms.findIndex(atom=>atom.repeated), repeated=repeats[0]!;
    for (const atom of atoms.slice(first+1)) {
      if (atom.source===repeated.source) continue;
      if (atom.literal===null) return refuse();
      // One atom has no quantifier/backtracking. Membership is a bounded syntax operation on one code point.
      const ecmaAtom=repeated.source.replace(/\\x\{([0-9a-f]+)\}/g,"\\u{$1}");
      if (new RegExp(`^(?:${ecmaAtom})$`,"u").test(atom.literal)) return refuse();
    }
  }
  if (!(pattern.startsWith("^")&&pattern.endsWith("$")) && (grouped || atoms.length>1 && (repeats.length>0 || atoms.some(atom=>atom.literal===null)))) return refuse();
  if(checkedPatterns.size>=128)checkedPatterns.delete(checkedPatterns.keys().next().value!);
  checkedPatterns.set(pattern,translated);
  return translated;
}
/** Thompson program: no input history, no DFA, and at most STATE_LIMIT states per cached pattern.
 * Predicates see exactly ONE Unicode code point, so the native regex parser cannot backtrack over input.
 */
function matcher(pattern: string): Program {
  const cached = matchers.get(pattern);
  if (cached) { matchers.delete(pattern); matchers.set(pattern, cached); return cached; }
  checkedMcpPattern(pattern);
  consumeMcpValidationWork(pattern.length);
  const states: State[] = [];
  const predicates = new Map<string, RegExp>();
  const add = (state: State): number => { consumeMcpValidationWork(1); if (states.length >= STATE_LIMIT) return refuse(); states.push(state); return states.length - 1; };
  type Node = { kind: "atom"; source: string } | { kind: "begin" | "end" | "empty" } | { kind: "sequence" | "choice"; children: Node[] } | { kind: "repeat"; child: Node; min: number; max: number };
  let offset = 0;
  const expression = (): Node => {
    const choices: Node[] = [];
    for (;;) {
      const sequence: Node[] = [];
      while (offset < pattern.length && pattern[offset] !== ")" && pattern[offset] !== "|") {
        let atom: Node;
        const start = offset, c = pattern[offset++]!;
        if (c === "(") { if (pattern.slice(offset, offset + 2) === "?:") offset += 2; atom = expression(); if (pattern[offset++] !== ")") return refuse(); }
        else if (c === "^" || c === "$") atom = { kind: c === "^" ? "begin" : "end" };
        else {
          if (c === "\\") {
            const escape = pattern[offset++]!;
            if (escape === "u") { if (pattern[offset] === "{") { while (pattern[offset++] !== "}") { if (offset > pattern.length) return refuse(); } } else offset += 4; }
            else if (escape === "x") offset += 2;
          } else if (c === "[") {
            while (offset < pattern.length) { const token = pattern[offset++]; if (token === "\\") offset++; else if (token === "]") break; }
          }
          atom = { kind: "atom", source: pattern.slice(start, offset) };
        }
        const q = pattern[offset];
        if (q && "*+?{".includes(q)) {
          offset++;
          let min = q === "+" ? 1 : 0, max = q === "?" ? 1 : Infinity;
          if (q === "{") { const count = /^(\d+)(?:,(\d*))?\}/.exec(pattern.slice(offset)); if (!count) return refuse(); min = Number(count[1]); max = count[2] === undefined ? min : count[2] === "" ? Infinity : Number(count[2]); offset += count[0].length; }
          atom = { kind: "repeat", child: atom, min, max };
          if (pattern[offset] === "?") offset++;
        }
        sequence.push(atom);
      }
      choices.push({ kind: "sequence", children: sequence });
      if (pattern[offset] !== "|") break;
      offset++;
    }
    return choices.length === 1 ? choices[0]! : { kind: "choice", children: choices };
  };
  const root = expression(); if (offset !== pattern.length) return refuse();
  const emit = (node: Node, next: number): number => {
    switch (node.kind) {
      case "empty": return next;
      case "begin": case "end": return add({ kind: node.kind, next });
      case "atom": { let predicate = predicates.get(node.source); if (!predicate) { consumeMcpValidationWork(node.source.length); predicate = new RegExp(`^(?:${node.source})$`, "u"); predicates.set(node.source, predicate); } return add({ kind: "atom", predicate, next }); }
      case "sequence": { let head = next; for (let i = node.children.length - 1; i >= 0; i--) head = emit(node.children[i]!, head); return head; }
      case "choice": { let head = emit(node.children[node.children.length - 1]!, next); for (let i = node.children.length - 2; i >= 0; i--) head = add({ kind: "split", next: emit(node.children[i]!, next), other: head }); return head; }
      case "repeat": {
        let head = next;
        if (node.max === Infinity) { const split = add({ kind: "split", next, other: next }); states[split] = { kind: "split", next: emit(node.child, split), other: next }; head = split; }
        else for (let i = node.min; i < node.max; i++) head = add({ kind: "split", next: emit(node.child, head), other: next });
        for (let i = 0; i < node.min; i++) head = emit(node.child, head);
        return head;
      }
    }
  };
  const program = { states, start: emit(root, add({ kind: "accept" })) };
  if (matchers.size >= CACHE_LIMIT) { matchers.delete(matchers.keys().next().value!); deleted++; }
  matchers.set(pattern, program); created++;
  return program;
}
function testProgram(program: Program, value: string): boolean {
  const budget = workBudget ?? { remaining: WORK_LIMIT };
  const charge = (): void => { if (--budget.remaining < 0) throw new McpPatternWorkLimit(); };
  const { states } = program;
  const seen = new Uint32Array(states.length);
  let generation = 0, active: number[] = [], next: number[] = [];
  const closure = (start: number, position: number, target: number[]): void => {
    const pending = [start];
    while (pending.length) {
      charge();
      const id = pending.pop()!; if (seen[id] === generation) continue; seen[id] = generation;
      const state = states[id]!;
      if (state.kind === "split") { pending.push(state.next, state.other); }
      else if (state.kind === "begin") { if (position === 0) pending.push(state.next); }
      else if (state.kind === "end") { if (position === value.length) pending.push(state.next); }
      else target.push(id);
    }
  };
  generation++; closure(program.start, 0, active);
  for (let position = 0;;) {
    if (active.some(id => states[id]!.kind === "accept")) return true;
    if (position === value.length) return false;
    const point = String.fromCodePoint(value.codePointAt(position)!);
    const end = position + point.length;
    generation++; next.length = 0;
    for (const id of active) { charge(); const state = states[id]!; if (state.kind === "atom" && state.predicate.test(point)) closure(state.next, end, next); }
    // Unanchored search shares one NFA frontier; it never restarts over every suffix.
    closure(program.start, end, next);
    const swap = active; active = next; next = swap; position = end;
  }
}
function wellFormed(value: string): boolean {
  for(let i=0;i<value.length;i++) {
    const unit=value.charCodeAt(i);
    if(unit>=0xd800&&unit<=0xdbff) { const next=value.charCodeAt(++i); if(!(next>=0xdc00&&next<=0xdfff))return false; }
    else if(unit>=0xdc00&&unit<=0xdfff)return false;
  }
  return true;
}
/** Closures look up by key at match time; eviction never leaves a stale program pointer. */
export const linearMcpRegExp: RegExpEngine = Object.assign((pattern: string, flags: string) => {
  if (flags !== "u" && flags !== "") return refuse();
  checkedMcpPattern(pattern);
  matcher(pattern);
  return { test: (value: string) => withMcpPatternBudget(() => { consumeMcpValidationWork(value.length); return wellFormed(value) && testProgram(matcher(pattern), value); }), toString: () => JSON.stringify([pattern, flags]) };
}, { code: "mcpLinearRegExp" });
/** Counts only, no schema/input/secret data. Used by deterministic leak regressions. */
export function mcpPatternCacheStats(): { live: number; created: number; deleted: number; limit: number; states: number; stateLimit: number; workLimit: number } {
  return { live: matchers.size, created, deleted, limit: CACHE_LIMIT, states: [...matchers.values()].reduce((total, program) => total + program.states.length, 0), stateLimit: STATE_LIMIT, workLimit: WORK_LIMIT };
}
