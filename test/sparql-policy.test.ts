import { describe, expect, it } from 'vitest';
import { IntegrationApiError } from '../src/errors.ts';
import {
  enforceSemanticQueryPolicy,
  SEMANTIC_QUERY_COST_BUDGET,
} from '../src/query-gateway/sparql-policy.ts';

const MAX_BYTES = 8 * 1024;

function failure(query: string): IntegrationApiError {
  try {
    enforceSemanticQueryPolicy(query, MAX_BYTES);
  } catch (error) {
    if (error instanceof IntegrationApiError) return error;
    throw error;
  }
  throw new Error('expected the policy to reject the query');
}

describe('agent-authored SPARQL policy', () => {
  it('accepts selective SELECT, ASK, and bounded CONSTRUCT exploration', () => {
    const select = enforceSemanticQueryPolicy(
      `SELECT ?decision ?name WHERE {
         GRAPH ?g {
           VALUES ?repository { <https://github.com/acme/api> }
           ?decision <http://dkg.io/ontology/software/repository> ?repository .
           OPTIONAL { ?decision <http://schema.org/name> ?name }
         }
       } LIMIT 25`,
      MAX_BYTES,
    );
    expect(select).toMatchObject({ queryType: 'select', limit: 25, offset: 0 });
    expect(select.score).toBeLessThanOrEqual(SEMANTIC_QUERY_COST_BUDGET);

    expect(
      enforceSemanticQueryPolicy(
        'ASK { GRAPH ?g { <urn:decision:1> <http://schema.org/name> ?name } }',
        MAX_BYTES,
      ),
    ).toMatchObject({ queryType: 'ask', limit: null });
    expect(
      enforceSemanticQueryPolicy(
        'CONSTRUCT { ?s <urn:related> ?o } WHERE { GRAPH ?g { ?s <urn:related> ?o } } LIMIT 10',
        MAX_BYTES,
      ),
    ).toMatchObject({ queryType: 'construct', limit: 10 });
  });

  it('blocks updates, DESCRIBE, datasets, federation, and explicit graph selection', () => {
    expect(failure('INSERT DATA { <urn:s> <urn:p> <urn:o> }').code).toBe('unsafe_query');
    expect(failure('DESCRIBE <urn:s>').code).toBe('unsafe_query');
    expect(failure('SELECT ?s FROM <urn:other> WHERE { ?s <urn:p> ?o } LIMIT 10').code).toBe(
      'unsafe_query',
    );
    expect(
      failure('SELECT ?s WHERE { SERVICE <https://remote.test/sparql> { ?s <urn:p> ?o } } LIMIT 10')
        .code,
    ).toBe('unsafe_query');
    expect(failure('SELECT ?s WHERE { GRAPH <urn:other> { ?s <urn:p> ?o } } LIMIT 10').code).toBe(
      'unsafe_query',
    );
  });

  it('blocks unbounded paths and unconstrained triple scans', () => {
    expect(failure('SELECT ?o WHERE { ?s <urn:parent>+ ?o } LIMIT 10').code).toBe('unsafe_query');
    const scan = failure('SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 10');
    expect(scan.code).toBe('unsafe_query');
    expect(scan.details?.suggestions).toContain(
      'Use exact entity or predicate IRIs, or bind variables with a small VALUES clause.',
    );
  });

  it('requires bounded output and returns machine-actionable cost feedback', () => {
    const noLimit = failure('SELECT ?s WHERE { ?s <urn:p> ?o }');
    expect(noLimit.code).toBe('query_too_expensive');
    expect(noLimit.status).toBe(422);
    expect(noLimit.details?.suggestions).toBeInstanceOf(Array);
    expect(failure('SELECT ?s WHERE { ?s <urn:p> ?o } LIMIT 25 OFFSET 10000').code).toBe(
      'query_too_expensive',
    );

    const predicates = Array.from(
      { length: 8 },
      (_, index) => `?s ?predicate${index} <urn:value:${index}> .`,
    ).join('\n');
    const expensive = failure(`SELECT ?s WHERE { ${predicates} } LIMIT 25`);
    expect(expensive.code).toBe('query_too_expensive');
    expect(expensive.details).toMatchObject({ budget: SEMANTIC_QUERY_COST_BUDGET });
    expect(Number(expensive.details?.score)).toBeGreaterThan(SEMANTIC_QUERY_COST_BUDGET);

    const aggregate = failure(
      'SELECT (COUNT(?o) AS ?count) WHERE { GRAPH ?g { ?s <urn:p> ?o } } LIMIT 1',
    );
    expect(aggregate.code).toBe('query_too_expensive');
    expect(aggregate.details).toMatchObject({ metrics: { aggregates: 1 } });

    const havingAggregate = failure(
      'SELECT ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } } GROUP BY ?s HAVING(COUNT(?o) > 10) LIMIT 25',
    );
    expect(havingAggregate.code).toBe('query_too_expensive');
    expect(havingAggregate.details).toMatchObject({ metrics: { aggregates: 1 } });

    const orderAggregate = failure(
      'SELECT ?s WHERE { GRAPH ?g { ?s <urn:p> ?o } } GROUP BY ?s ORDER BY DESC(COUNT(?o)) LIMIT 25',
    );
    expect(orderAggregate.code).toBe('query_too_expensive');
    expect(orderAggregate.details).toMatchObject({ metrics: { aggregates: 1 } });
  });

  it('permits a fully variable pattern only when VALUES anchors one variable', () => {
    expect(
      enforceSemanticQueryPolicy(
        'SELECT ?p ?o WHERE { VALUES ?s { <urn:known> } ?s ?p ?o } LIMIT 10',
        MAX_BYTES,
      ),
    ).toMatchObject({ queryType: 'select' });
  });

  it('does not let scoped VALUES bindings authorize unrelated scans', () => {
    expect(
      failure(`SELECT ?s ?p ?o WHERE {
        OPTIONAL { VALUES ?s { <urn:known> } }
        GRAPH ?g { ?s ?p ?o }
      } LIMIT 25`).code,
    ).toBe('unsafe_query');

    expect(
      failure(`SELECT ?s ?p ?o WHERE {
        { VALUES ?s { <urn:known> } ?s ?p ?o }
        UNION
        { ?s ?p ?o }
      } LIMIT 25`).code,
    ).toBe('unsafe_query');
  });

  it('rejects CONSTRUCT templates whose bounded fanout can exceed the quad cap', () => {
    const error = failure(`CONSTRUCT {
      ?s <urn:p1> ?o1 .
      ?s <urn:p2> ?o2 .
      ?s <urn:p3> ?o3 .
      ?s <urn:p4> ?o4 .
    } WHERE {
      GRAPH ?g {
        ?s <urn:p1> ?o1 ; <urn:p2> ?o2 ; <urn:p3> ?o3 ; <urn:p4> ?o4 .
      }
    } LIMIT 100`);
    expect(error.status).toBe(422);
    expect(error.code).toBe('query_too_expensive');
    expect(error.details).toMatchObject({ templateTriples: 4, maximumQuads: 400, maxQuads: 300 });
  });
});
