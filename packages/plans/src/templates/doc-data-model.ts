/**
 * Data Model template — database schemas and entity relationships.
 */

export const DOC_DATA_MODEL_TEMPLATE = `# Data Model: {{title}}

## Models
<!-- List each database model/entity and its purpose. -->

### ModelName
<!-- Purpose of this model. Key behaviors. -->

## Fields
<!-- Document fields for each model. -->

### ModelName

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | UUID | auto | generated | Primary key |

## Relationships
<!-- Entity relationships with cardinality. -->

| From | Relationship | To | Description |
|------|-------------|-----|------------|
| | has many / belongs to | | |

## Indexes
<!-- Performance-critical indexes. -->

| Table | Fields | Type | Reason |
|-------|--------|------|--------|
| | | unique / btree / gin | |

## Migrations
<!-- Migration tool and naming convention. How to create and run migrations. -->


## Constraints
<!-- Unique constraints, check constraints, foreign key rules. -->


## Enums
<!-- Enum types used across models. -->

| Enum | Values | Used in |
|------|--------|---------|
| | | |

---
*Created: {{date}}*
*Document type: data-model*
`;

export function renderDataModelTemplate(title: string): string {
  return DOC_DATA_MODEL_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
