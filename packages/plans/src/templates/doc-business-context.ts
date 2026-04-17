/**
 * Business Context template — goals, users, and success criteria.
 */

export const DOC_BUSINESS_CONTEXT_TEMPLATE = `# Business Context: {{title}}

## Goals
<!-- What business objectives does this project serve? -->

1.
2.
3.

## Users
<!-- Target user personas and their needs. -->

### Persona 1
<!-- Role, technical level, primary use case, pain points. -->

## Success Criteria
<!-- How will you measure success? Specific, quantifiable. -->

- [ ]
- [ ]
- [ ]

## User Stories
<!-- Key user stories in "As a ... I want ... So that ..." format. -->

## Constraints
<!-- Business or technical constraints that bound the solution. -->


## Metrics
<!-- Key metrics that indicate the system is working as intended. -->

| Metric | Target | How measured |
|--------|--------|-------------|
| | | |

## Competitors
<!-- Existing solutions in this space. What they do well, gaps. -->


---
*Created: {{date}}*
*Document type: business-context*
`;

export function renderBusinessContextTemplate(title: string): string {
  return DOC_BUSINESS_CONTEXT_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
