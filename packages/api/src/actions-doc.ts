import { listModules } from '@hubium/core';
import { z } from 'zod';

// The module actions behind POST /activities/{id}/actions/{name}, documented from each
// action's own input schema, so the reference follows the modules without extra work.

export const ACTIONS_PATH = '/api/v1/activities/{id}/actions/{name}';

type Json = Record<string, unknown>;

/** A list of uploaded files ({ name, mimeType, data }) can only come as multipart parts. */
function isFileList(p: Json): boolean {
  const props = (p.items as Json | undefined)?.properties as Json | undefined;
  return p.type === 'array' && !!props && 'data' in props && 'mimeType' in props;
}

function inputSchema(input: z.ZodType): Json {
  let s: Json;
  try {
    s = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' }) as Json;
  } catch {
    s = { type: 'object' };
  }
  delete s.$schema;
  for (const [key, p] of Object.entries((s.properties as Record<string, Json>) ?? {})) {
    if (!isFileList(p)) continue;
    (s.properties as Json)[key] = {
      type: 'array',
      items: { type: 'string', format: 'binary' },
      description: `Files: send the request as multipart/form-data, the files as \`files\` parts${key === 'files' ? '' : ` and \`filesField=${key}\``}`,
    };
  }
  return s;
}

interface ActionDoc {
  module: string;
  name: string;
  capability?: string;
  summary?: string;
  schema: Json;
}

export function moduleActions(): ActionDoc[] {
  return listModules()
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap((m) =>
      Object.entries(m.actions ?? {}).map(([name, a]) => ({
        module: m.key,
        name,
        capability: a.capability,
        summary: a.summary,
        schema: inputSchema(a.input),
      })),
    );
}

/** Adds every module action to the spec: an input schema each and a table in the route. */
export function documentModuleActions(doc: Json): Json {
  const actions = moduleActions();
  const schemas = ((doc.components as Json).schemas ??= {}) as Json;
  for (const a of actions)
    schemas[`Action.${a.module}.${a.name}`] = {
      ...a.schema,
      title: `${a.module}: ${a.name}`,
      ...(a.summary ? { description: a.summary } : {}),
    };
  const op = ((doc.paths as Json)[ACTIONS_PATH] as Json | undefined)?.post as Json | undefined;
  if (!op) return doc;
  const table = [
    '| Module | Action | Capability | What it does |',
    '|---|---|---|---|',
    ...actions.map(
      (a) =>
        `| ${a.module} | \`${a.name}\` | ${a.capability ? `\`${a.capability}\`` : 'checked by the action'} | ${a.summary ?? ''} |`,
    ),
  ].join('\n');
  op.description = `${op.description ?? ''}\n\n${table}`.trim();
  const name = (op.parameters as Json[] | undefined)?.find((p) => p.name === 'name');
  if (name)
    name.schema = {
      ...(name.schema as Json),
      enum: [...new Set(actions.map((a) => a.name))].sort(),
    };
  const json = ((op.requestBody as Json).content as Json)['application/json'] as Json;
  json.schema = {
    anyOf: actions.map((a) => ({ $ref: `#/components/schemas/Action.${a.module}.${a.name}` })),
  };
  return doc;
}
