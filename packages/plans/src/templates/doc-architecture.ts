/**
 * Architecture template — system design and component relationships.
 */

export const DOC_ARCHITECTURE_TEMPLATE = `# Architecture: {{title}}

## Components
<!-- List each major component/module with its responsibility. -->

### Component 1
<!-- Responsibility, key files, public API surface. -->


## Data Flow
<!-- How does data move through the system? Key pipelines and transformations. -->


## Dependencies
<!-- External services, libraries, and infrastructure this system depends on. -->

| Dependency | Purpose | Critical? |
|-----------|---------|-----------|
| | | |

## Design Decisions
<!-- Key architectural decisions and their rationale (ADR format). -->

### Decision 1
- **Context**: Why was this decision needed?
- **Options considered**:
- **Outcome**: What was chosen and why.

## Security
<!-- Authentication, authorization, data protection approach. -->


## Performance
<!-- Performance characteristics, bottlenecks, caching strategy. -->


## Scalability
<!-- How the system scales. Known limits. -->


---
*Created: {{date}}*
*Document type: architecture*
`;

export function renderArchitectureTemplate(title: string): string {
  return DOC_ARCHITECTURE_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
