// Validating format B (ProseMirror JSON) the way an agent would get feedback:
//   1. JSON.parse                 (syntax)
//   2. JSON Schema (ajv)          generated from the ProseMirror schema: node/mark type names, attr names
//   3. ProseMirror itself          Node.fromJSON(schema, json).check(): content expressions, mark rules
// and the same agent mistakes run through the HTML checker for comparison.
import Ajv from 'ajv'
import { Node as PMNode } from '@tiptap/pm/model'
import { schema } from './pipeline.ts'

/** JSON Schema for ProseMirror JSON documents of this schema (what can be expressed reasonably) */
export function jsonSchemaFor(): object {
  const nodeTypes = Object.keys(schema.nodes)
  const markTypes = Object.keys(schema.marks)
  const attrsOf = (spec: any) => ({
    type: 'object',
    properties: Object.fromEntries(Object.keys(spec.attrs ?? {}).map((k) => [k, {}])),
    additionalProperties: false,
  })
  return {
    $id: 'pm-doc',
    $ref: '#/definitions/node',
    definitions: {
      mark: {
        type: 'object',
        required: ['type'],
        properties: { type: { enum: markTypes }, attrs: { type: 'object' } },
        additionalProperties: false,
        allOf: markTypes.map((t) => ({ if: { properties: { type: { const: t } } }, then: { properties: { attrs: attrsOf(schema.marks[t].spec) } } })),
      },
      node: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: nodeTypes },
          attrs: { type: 'object' },
          content: { type: 'array', items: { $ref: '#/definitions/node' } },
          marks: { type: 'array', items: { $ref: '#/definitions/mark' } },
          text: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
        allOf: [
          { if: { properties: { type: { const: 'text' } } }, then: { required: ['text'] }, else: { not: { required: ['text'] } } },
          ...nodeTypes.map((t) => ({ if: { properties: { type: { const: t } } }, then: { properties: { attrs: attrsOf(schema.nodes[t].spec) } } })),
        ],
      },
    },
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(jsonSchemaFor())

export interface JsonVerdict {
  parse: string
  jsonSchema: string
  prosemirror: string
}

export function checkJsonText(text: string): JsonVerdict {
  let json: any
  try {
    json = JSON.parse(text)
  } catch (e) {
    const msg = (e as Error).message
    return { parse: `✗ ${msg}`, jsonSchema: '–', prosemirror: '–' }
  }
  const doc = json.doc ?? json
  let jsonSchema = '✓ valid'
  if (!validate(doc)) {
    // ajv reports every failing branch; the most specific (deepest) error is the useful one
    const errs = [...(validate.errors ?? [])].filter((e) => e.keyword !== 'if')
    errs.sort((a, b) => b.instancePath.length - a.instancePath.length)
    const e = errs[0]
    jsonSchema = `✗ ${e.instancePath || '/'} ${e.message}${e.params && 'allowedValues' in e.params ? ` (${(e.params as any).allowedValues.length} allowed values)` : ''}${'additionalProperty' in (e.params ?? {}) ? ` "${(e.params as any).additionalProperty}"` : ''} [${errs.length} error(s)]`
  }
  let prosemirror = '✓ valid'
  try {
    PMNode.fromJSON(schema, doc).check()
  } catch (e) {
    prosemirror = `✗ ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}`
  }
  return { parse: '✓', jsonSchema, prosemirror }
}
