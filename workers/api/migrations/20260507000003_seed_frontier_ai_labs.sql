-- Seed the first collection: "Frontier AI Labs". Membership is keyed on org
-- slug, so the row set is whatever subset already exists at migration time;
-- unresolved slugs are skipped and orgs onboarded later are NOT retroactively
-- added — operators must INSERT into collection_members directly.
INSERT OR IGNORE INTO collections (id, slug, name, description, created_at, updated_at)
VALUES (
  'col_seed_frontier_ai_labs',
  'frontier-ai-labs',
  'Frontier AI Labs',
  'Frontier AI research labs and model providers, side by side.',
  '2026-05-07T00:00:00.000Z',
  '2026-05-07T00:00:00.000Z'
);

INSERT OR IGNORE INTO collection_members (collection_id, org_id, position, created_at)
SELECT
  'col_seed_frontier_ai_labs',
  o.id,
  CASE o.slug
    WHEN 'anthropic' THEN 0
    WHEN 'openai' THEN 1
    WHEN 'google-deepmind' THEN 2
    WHEN 'deepmind' THEN 2
    WHEN 'meta-ai' THEN 3
    WHEN 'mistral' THEN 4
    WHEN 'mistral-ai' THEN 4
    WHEN 'xai' THEN 5
    WHEN 'cohere' THEN 6
    WHEN 'perplexity' THEN 7
    WHEN 'inflection' THEN 8
    WHEN 'inflection-ai' THEN 8
    ELSE 99
  END,
  '2026-05-07T00:00:00.000Z'
FROM organizations o
WHERE o.slug IN (
  'anthropic',
  'openai',
  'google-deepmind',
  'deepmind',
  'meta-ai',
  'mistral',
  'mistral-ai',
  'xai',
  'cohere',
  'perplexity',
  'inflection',
  'inflection-ai'
);
