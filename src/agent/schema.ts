import type { JsonSchema } from './types';

/**
 * Validates model-produced tool input against the tool's schema. Tool inputs
 * are untrusted output: with eager streaming the API does not validate them,
 * and local models regularly get them wrong. Returns a list of problems.
 */
export function validate(schema: JsonSchema, input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['input must be a JSON object'];
  const obj = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required ?? []) if (obj[key] === undefined || obj[key] === null) errors.push(`missing required property "${key}"`);
  for (const [key, value] of Object.entries(obj)) {
    const prop = schema.properties[key];
    if (!prop) {
      if (schema.additionalProperties === false) errors.push(`unknown property "${key}"`);
      continue;
    }
    if (value === undefined || value === null) continue;
    const type = prop.type as string | undefined;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = !type || type === actual || (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) || (type === 'number' && actual === 'number');
    if (!ok) errors.push(`property "${key}" must be ${type}, got ${actual}`);
    else if (Array.isArray(prop.enum) && !prop.enum.includes(value)) errors.push(`property "${key}" must be one of ${JSON.stringify(prop.enum)}`);
  }
  return errors;
}
