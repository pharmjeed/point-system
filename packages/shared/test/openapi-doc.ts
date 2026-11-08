/**
 * A reader of docs/07_openapi.yaml for the contract tests (no YAML dependency: the file's layout is fixed —
 * two-space indentation, `x-` extensions per operation, error codes listed in the response descriptions).
 */

export interface OpenApiOperation {
  method: string;
  path: string;
  /** `x-error-codes` of the operation */
  xErrorCodes: string[];
  /** status → the canon codes its description lists (`A | B | C`, continuation lines included) */
  responses: Map<number, string[]>;
  /** the operation declares a `requestBody` */
  requestBody: boolean;
}

const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

export function openApiOperations(yaml: string): OpenApiOperation[] {
  const lines = yaml.split('\n');
  const ops: OpenApiOperation[] = [];
  let path: string | null = null;
  let op: OpenApiOperation | null = null;
  let status: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const p = /^ {2}(\/\S+):\s*$/.exec(line);
    if (p?.[1]) {
      path = p[1];
      op = null;
      continue;
    }
    if (/^\S/.test(line)) {
      path = null;
      op = null;
      continue;
    }
    const m = path ? /^ {4}(get|post|put|patch|delete):\s*$/.exec(line) : null;
    if (path && m?.[1]) {
      op = { method: m[1].toUpperCase(), path, xErrorCodes: [], responses: new Map(), requestBody: false };
      ops.push(op);
      status = null;
      continue;
    }
    if (!op) continue;
    if (/^ {6}\S/.test(line)) status = null; // another operation-level key ends the responses block
    if (/^ {6}requestBody:\s*$/.test(line)) op.requestBody = true;
    const s = /^ {8}'(\d{3})':\s*$/.exec(line);
    if (s?.[1]) {
      status = Number(s[1]);
      continue;
    }
    const d = status !== null ? /^ {10}description: (.*)$/.exec(line) : null;
    if (d && status !== null) {
      let text = d[1] ?? '';
      while (/^ {12}\S/.test(lines[i + 1] ?? '')) text += ` ${(lines[++i] ?? '').trim()}`;
      const codes = text
        .split('|')
        .map((c) => c.trim())
        .filter((c) => CODE.test(c));
      if (codes.length) op.responses.set(status, codes);
      continue;
    }
    const x = /^ {6}x-error-codes: \[(.*)$/.exec(line);
    if (x) {
      let text = x[1] ?? '';
      while (!text.includes(']') && i + 1 < lines.length) text += ` ${(lines[++i] ?? '').trim()}`;
      op.xErrorCodes = text
        .replace(/\].*$/, '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    }
  }
  return ops;
}

/** Every code an operation documents (x-error-codes and the response descriptions). */
export function documentedCodes(op: OpenApiOperation): Set<string> {
  return new Set([...op.xErrorCodes, ...[...op.responses.values()].flat()]);
}
