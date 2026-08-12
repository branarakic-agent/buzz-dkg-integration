import { Parser } from '@traqula/parser-sparql-1-1';
import { IntegrationApiError } from '../errors.ts';

export const SEMANTIC_QUERY_MAX_LIMIT = 100;
export const SEMANTIC_QUERY_DEFAULT_LIMIT = 25;
export const SEMANTIC_QUERY_COST_BUDGET = 40;
export const SEMANTIC_QUERY_MAX_QUADS = 300;

export interface SemanticQueryMetrics {
  triples: number;
  optionalPatterns: number;
  unionBranches: number;
  filters: number;
  graphPatterns: number;
  propertyPaths: number;
  variablePredicates: number;
  subqueries: number;
  valuesRows: number;
  aggregates: number;
  orderConditions: number;
  groupConditions: number;
  distinct: number;
}

export interface SemanticQueryPolicyResult {
  queryType: 'select' | 'ask' | 'construct';
  limit: number | null;
  offset: number;
  score: number;
  budget: number;
  metrics: SemanticQueryMetrics;
}

type JsonObject = Record<string, unknown>;

const parser = new Parser();
const MAX_TRIPLES = 16;
const MAX_OPTIONALS = 6;
const MAX_UNION_BRANCHES = 4;
const MAX_SUBQUERIES = 0;
const MAX_VALUES_ROWS = 50;
const MAX_GRAPH_PATTERNS = 4;

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function policyError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new IntegrationApiError(status, code, message, details);
}

function unsafe(message: string, suggestions: string[]): never {
  policyError(400, 'unsafe_query', message, { suggestions });
}

function variableName(value: unknown): string | null {
  return object(value) && value.type === 'term' && value.subType === 'variable'
    ? String(value.value ?? '')
    : null;
}

function children(value: JsonObject): unknown[] {
  return Object.entries(value)
    .filter(([key]) => key !== 'loc' && key !== 'context')
    .flatMap(([, child]) => (Array.isArray(child) ? child : [child]));
}

function walk(value: unknown, visit: (node: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!object(value)) return;
  visit(value);
  for (const child of children(value)) walk(child, visit);
}

function queryLimit(ast: JsonObject): number | null {
  const modifiers = object(ast.solutionModifiers) ? ast.solutionModifiers : null;
  const limitOffset = modifiers && object(modifiers.limitOffset) ? modifiers.limitOffset : null;
  return typeof limitOffset?.limit === 'number' ? limitOffset.limit : null;
}

function queryOffset(ast: JsonObject): number {
  const modifiers = object(ast.solutionModifiers) ? ast.solutionModifiers : null;
  const limitOffset = modifiers && object(modifiers.limitOffset) ? modifiers.limitOffset : null;
  return typeof limitOffset?.offset === 'number' ? limitOffset.offset : 0;
}

function valuesAnchors(value: unknown): Set<string> {
  const anchors = new Set<string>();
  if (!object(value) || value.type !== 'pattern' || value.subType !== 'values') return anchors;
  const variables = Array.isArray(value.variables) ? value.variables : [];
  const values = Array.isArray(value.values) ? value.values : [];
  for (const variable of variables) {
    const name = variableName(variable);
    if (name && values.some((row) => object(row) && object(row[name]))) anchors.add(name);
  }
  return anchors;
}

function validatePatternList(
  patterns: unknown[],
  inheritedAnchors: ReadonlySet<string>,
  violations: string[],
): void {
  const anchors = new Set(inheritedAnchors);
  // VALUES is join-compatible with its mandatory siblings regardless of textual order. Only
  // direct siblings contribute here: bindings inside OPTIONAL or one UNION arm must not escape.
  for (const pattern of patterns) {
    for (const name of valuesAnchors(pattern)) anchors.add(name);
  }
  for (const pattern of patterns) validateBroadScans(pattern, anchors, violations);
}

function validateBroadScans(
  value: unknown,
  inheritedAnchors: ReadonlySet<string>,
  violations: string[],
): void {
  if (Array.isArray(value)) {
    validatePatternList(value, inheritedAnchors, violations);
    return;
  }
  if (!object(value) || value.type !== 'pattern') return;
  if (value.subType === 'values') return;
  if (value.subType === 'union') {
    const branches = Array.isArray(value.patterns) ? value.patterns : [];
    for (const branch of branches) validateBroadScans(branch, inheritedAnchors, violations);
    return;
  }
  if (value.subType === 'bgp') {
    const triples = Array.isArray(value.triples) ? value.triples : [];
    for (const triple of triples) {
      if (!object(triple)) continue;
      const subject = variableName(triple.subject);
      const predicate = variableName(triple.predicate);
      const objectName = variableName(triple.object);
      if (
        subject &&
        predicate &&
        objectName &&
        !inheritedAnchors.has(subject) &&
        !inheritedAnchors.has(predicate) &&
        !inheritedAnchors.has(objectName)
      ) {
        violations.push('fully unbound triple pattern is not allowed');
      }
    }
    return;
  }
  const patterns = Array.isArray(value.patterns) ? value.patterns : [];
  validatePatternList(patterns, inheritedAnchors, violations);
}

function constructTemplateTripleCount(ast: JsonObject): number {
  let count = 0;
  walk(ast.template, (node) => {
    if (node.type === 'pattern' && node.subType === 'bgp' && Array.isArray(node.triples)) {
      count += node.triples.length;
    }
  });
  return count;
}

/** Parse and statically bound one agent-authored, read-only SPARQL 1.1 query. */
export function enforceSemanticQueryPolicy(
  sparql: string,
  maxQueryBytes: number,
): SemanticQueryPolicyResult {
  if (!sparql.trim() || Buffer.byteLength(sparql, 'utf8') > maxQueryBytes) {
    policyError(413, 'query_too_large', 'SPARQL query exceeds the configured size limit', {
      maxQueryBytes,
      suggestions: [
        'Submit a smaller query or split the exploration into several focused queries.',
      ],
    });
  }

  let ast: unknown;
  try {
    ast = parser.parse(sparql);
  } catch {
    policyError(400, 'invalid_sparql', 'query is not valid SPARQL 1.1', {
      suggestions: [
        'Check prefixes, braces, variables, and string escaping.',
        `Use LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} for SELECT or CONSTRUCT queries.`,
      ],
    });
  }
  if (!object(ast) || ast.type !== 'query') {
    unsafe('only read-only SPARQL queries are allowed', [
      'Use SELECT, ASK, or CONSTRUCT. INSERT, DELETE, LOAD, CLEAR, and other updates are blocked.',
    ]);
  }
  if (ast.subType !== 'select' && ast.subType !== 'ask' && ast.subType !== 'construct') {
    unsafe('this SPARQL query form is not allowed', [
      'Use SELECT for facts, ASK for existence checks, or a bounded CONSTRUCT for a small subgraph.',
    ]);
  }
  const queryType = ast.subType;
  const datasets =
    object(ast.datasets) && Array.isArray(ast.datasets.clauses) ? ast.datasets.clauses : [];
  if (datasets.length > 0) {
    unsafe('FROM and FROM NAMED clauses are not allowed', [
      'Remove dataset clauses; the relay selects the current channel Context Graph server-side.',
      'Use GRAPH ?g inside the query when provenance graph identifiers are needed.',
    ]);
  }

  const limit = queryLimit(ast);
  const offset = queryOffset(ast);
  if (queryType !== 'ask' && limit === null) {
    policyError(422, 'query_too_expensive', 'SELECT and CONSTRUCT queries require LIMIT', {
      score: null,
      budget: SEMANTIC_QUERY_COST_BUDGET,
      suggestions: [
        `Add LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} (maximum ${SEMANTIC_QUERY_MAX_LIMIT}).`,
      ],
    });
  }
  if (
    limit !== null &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > SEMANTIC_QUERY_MAX_LIMIT)
  ) {
    policyError(422, 'query_too_expensive', 'query LIMIT is outside the allowed range', {
      limit,
      maxLimit: SEMANTIC_QUERY_MAX_LIMIT,
      suggestions: [`Use a LIMIT between 1 and ${SEMANTIC_QUERY_MAX_LIMIT}.`],
    });
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > SEMANTIC_QUERY_MAX_LIMIT) {
    policyError(422, 'query_too_expensive', 'query OFFSET is outside the allowed range', {
      offset,
      maxOffset: SEMANTIC_QUERY_MAX_LIMIT,
      suggestions: [
        'Use keyset-style pagination anchored on the last known entity instead of a large OFFSET.',
      ],
    });
  }

  const metrics: SemanticQueryMetrics = {
    triples: 0,
    optionalPatterns: 0,
    unionBranches: 0,
    filters: 0,
    graphPatterns: 0,
    propertyPaths: 0,
    variablePredicates: 0,
    subqueries: 0,
    valuesRows: 0,
    aggregates: 0,
    orderConditions: 0,
    groupConditions: 0,
    distinct: ast.distinct === true ? 1 : 0,
  };
  const modifiers = object(ast.solutionModifiers) ? ast.solutionModifiers : {};
  const order = object(modifiers.order) ? modifiers.order : null;
  const group = object(modifiers.group) ? modifiers.group : null;
  const having = object(modifiers.having) ? modifiers.having : null;
  walk([ast.variables, order, having], (node) => {
    if (node.type === 'expression' && node.subType === 'aggregate') metrics.aggregates += 1;
  });
  metrics.orderConditions = order && Array.isArray(order.orderDefs) ? order.orderDefs.length : 0;
  metrics.groupConditions = group && Array.isArray(group.groupings) ? group.groupings.length : 0;
  walk(ast.where, (node) => {
    if (node.type !== 'pattern' || node.subType !== 'values') return;
    const values = Array.isArray(node.values) ? node.values : [];
    metrics.valuesRows += values.length;
  });

  const violations: string[] = [];
  walk(ast.where, (node) => {
    if (node.type === 'query') metrics.subqueries += 1;
    if (node.type === 'path') {
      metrics.propertyPaths += 1;
      if (node.subType === '*' || node.subType === '+' || node.subType === '!') {
        violations.push(`property path '${String(node.subType)}' is not bounded`);
      }
    }
    if (node.type !== 'pattern') return;
    if (node.subType === 'service') violations.push('SERVICE federation is not allowed');
    if (node.subType === 'optional') metrics.optionalPatterns += 1;
    if (node.subType === 'filter') metrics.filters += 1;
    if (node.subType === 'union') {
      metrics.unionBranches += Array.isArray(node.patterns) ? node.patterns.length : 0;
    }
    if (node.subType === 'graph') {
      metrics.graphPatterns += 1;
      if (variableName(node.name) === null) {
        violations.push('explicit GRAPH identifiers are not allowed');
      }
    }
    if (node.subType !== 'bgp') return;
    const triples = Array.isArray(node.triples) ? node.triples : [];
    metrics.triples += triples.length;
    for (const triple of triples) {
      if (!object(triple)) continue;
      const predicate = variableName(triple.predicate);
      if (predicate) metrics.variablePredicates += 1;
    }
  });
  validateBroadScans(ast.where, new Set(), violations);

  if (violations.length > 0) {
    unsafe(violations[0]!, [
      'Use exact entity or predicate IRIs, or bind variables with a small VALUES clause.',
      'Remove SERVICE, explicit GRAPH identifiers, and unbounded *, +, or ! property paths.',
      'Split broad discovery into a small selective query followed by focused queries.',
    ]);
  }
  if (
    metrics.triples > MAX_TRIPLES ||
    metrics.optionalPatterns > MAX_OPTIONALS ||
    metrics.unionBranches > MAX_UNION_BRANCHES ||
    metrics.subqueries > MAX_SUBQUERIES ||
    metrics.valuesRows > MAX_VALUES_ROWS ||
    metrics.graphPatterns > MAX_GRAPH_PATTERNS
  ) {
    policyError(422, 'query_too_expensive', 'query exceeds a structural cost limit', {
      budget: SEMANTIC_QUERY_COST_BUDGET,
      metrics,
      limits: {
        triples: MAX_TRIPLES,
        optionalPatterns: MAX_OPTIONALS,
        unionBranches: MAX_UNION_BRANCHES,
        subqueries: MAX_SUBQUERIES,
        valuesRows: MAX_VALUES_ROWS,
        graphPatterns: MAX_GRAPH_PATTERNS,
      },
      suggestions: [
        'Query one entity, repository, component, or decision at a time.',
        'Use VALUES to anchor known URIs and remove optional fields you do not need yet.',
      ],
    });
  }

  if (queryType === 'construct') {
    const templateTriples = constructTemplateTripleCount(ast);
    const maximumQuads = templateTriples * (limit ?? 0);
    if (templateTriples < 1 || maximumQuads > SEMANTIC_QUERY_MAX_QUADS) {
      policyError(422, 'query_too_expensive', 'CONSTRUCT result may exceed the allowed size', {
        templateTriples,
        limit,
        maximumQuads,
        maxQuads: SEMANTIC_QUERY_MAX_QUADS,
        suggestions: [
          'Reduce LIMIT or construct fewer triples per matched solution.',
          'Use SELECT to discover a small set of entities, then run a focused CONSTRUCT query.',
        ],
      });
    }
  }

  const score =
    2 +
    metrics.triples * 2 +
    metrics.optionalPatterns * 3 +
    metrics.unionBranches * 4 +
    metrics.subqueries * 8 +
    metrics.filters +
    metrics.graphPatterns +
    metrics.propertyPaths * 4 +
    metrics.variablePredicates * 6 +
    metrics.aggregates * 36 +
    metrics.orderConditions * 12 +
    metrics.groupConditions * 20 +
    metrics.distinct * 3 +
    (queryType === 'construct' ? 4 : 0);
  if (score > SEMANTIC_QUERY_COST_BUDGET) {
    policyError(422, 'query_too_expensive', 'estimated query cost exceeds the budget', {
      score,
      budget: SEMANTIC_QUERY_COST_BUDGET,
      metrics,
      suggestions: [
        'Replace variable predicates with exact predicate IRIs.',
        'Remove optional or union branches and fetch those details in a follow-up query.',
        'Fetch a bounded row set and sort, group, or aggregate it in the agent process.',
        `Reduce the result to LIMIT ${SEMANTIC_QUERY_DEFAULT_LIMIT} and bind known entities with VALUES.`,
      ],
    });
  }
  return { queryType, limit, offset, score, budget: SEMANTIC_QUERY_COST_BUDGET, metrics };
}
