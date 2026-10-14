import { listModules } from '@hubium/core';
import { z } from 'zod';

// The module actions behind POST /activities/{id}/actions/{name} and the queries behind
// GET /activities/{id}/queries/{name}, documented from each one's own schemas, so the
// reference follows the modules without extra work.

export const ACTIONS_PATH = '/api/v1/activities/{id}/actions/{name}';
export const QUERIES_PATH = '/api/v1/activities/{id}/queries/{name}';

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

interface QueryDoc {
  module: string;
  name: string;
  capability?: string;
  summary?: string;
  params: { name: string; required: boolean; schema: Json; description?: string }[];
  output?: Json;
}

function outputSchema(output: z.ZodType): Json {
  let s: Json;
  try {
    s = z.toJSONSchema(output, { io: 'output', unrepresentable: 'any' }) as Json;
  } catch {
    s = {};
  }
  delete s.$schema;
  return s;
}

export function moduleQueries(): QueryDoc[] {
  return listModules()
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap((m) =>
      Object.entries(m.queries ?? {}).map(([name, q]) => {
        const input = inputSchema(q.input);
        const required = new Set((input.required as string[] | undefined) ?? []);
        const props = (input.properties as Record<string, Json> | undefined) ?? {};
        return {
          module: m.key,
          name,
          capability: q.capability,
          summary: q.summary,
          params: Object.entries(props).map(([p, schema]) => ({
            name: p,
            required: required.has(p) && !('default' in schema),
            schema,
            ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
          })),
          output: q.output ? outputSchema(q.output) : undefined,
        };
      }),
    );
}

/** Adds every module query to the spec: its result schema, its parameters and a table. */
export function documentModuleQueries(doc: Json): Json {
  const queries = moduleQueries();
  const schemas = ((doc.components as Json).schemas ??= {}) as Json;
  for (const q of queries)
    if (q.output)
      schemas[`Query.${q.module}.${q.name}`] = {
        ...q.output,
        title: `${q.module}: ${q.name}`,
        ...(q.summary ? { description: q.summary } : {}),
      };
  const op = ((doc.paths as Json)[QUERIES_PATH] as Json | undefined)?.get as Json | undefined;
  if (!op) return doc;
  const table = [
    '| Module | Query | Parameters | Capability | What it returns |',
    '|---|---|---|---|---|',
    ...queries.map(
      (q) =>
        `| ${q.module} | \`${q.name}\` | ${q.params.map((p) => `\`${p.name}\`${p.required ? '' : '?'}`).join(', ') || '—'} | ${q.capability ? `\`${q.capability}\`` : 'opening the activity'} | ${q.summary ?? ''} |`,
    ),
  ].join('\n');
  op.description = `${op.description ?? ''}\n\n${table}`.trim();
  const params = (op.parameters as Json[] | undefined) ?? [];
  const name = params.find((p) => p.name === 'name');
  if (name)
    name.schema = {
      ...(name.schema as Json),
      enum: [...new Set(queries.map((q) => q.name))].sort(),
    };
  // The free-form query object becomes the union of the queries' parameters.
  const seen = new Set<string>();
  op.parameters = [
    ...params.filter((p) => p.in !== 'query'),
    ...queries.flatMap((q) =>
      q.params
        .filter((p) => !seen.has(p.name) && seen.add(p.name))
        .map((p) => ({
          name: p.name,
          in: 'query',
          required: false,
          schema: p.schema,
          description: `${p.description ? `${p.description}. ` : ''}Used by: ${queries
            .filter((x) => x.params.some((y) => y.name === p.name))
            .map((x) => `${x.module}.${x.name}`)
            .join(', ')}`,
        })),
    ),
  ];
  const json = ((((op.responses as Json)['200'] as Json).content as Json)['application/json'] ??
    {}) as Json;
  json.schema = {
    type: 'object',
    properties: {
      data: {
        anyOf: queries
          .filter((q) => q.output)
          .map((q) => ({ $ref: `#/components/schemas/Query.${q.module}.${q.name}` })),
      },
    },
    required: ['data'],
  };
  return doc;
}
