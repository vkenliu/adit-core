/**
 * Roadmap template — breaking vision into phases.
 */

export const ROADMAP_TEMPLATE = `# Roadmap: {{title}}

*Parent Intent: {{intentTitle}}*

## Phase 1: Foundation
<!-- Core infrastructure and setup -->

**Goal:**
**Deliverables:**
- [ ]
- [ ]

## Phase 2: Core Features
<!-- The minimum viable functionality -->

**Goal:**
**Deliverables:**
- [ ]
- [ ]

## Phase 3: Enhancement
<!-- Polish, optimization, additional features -->

**Goal:**
**Deliverables:**
- [ ]
- [ ]

## Dependencies
<!-- What must happen before each phase? External dependencies? -->


## Risks
<!-- What could go wrong? What's your mitigation strategy? -->


---
*Created: {{date}}*
*Status: draft*
`;

export function renderRoadmapTemplate(
  title: string,
  intentTitle: string,
): string {
  return ROADMAP_TEMPLATE.replace(/\{\{title\}\}/g, title)
    .replace(/\{\{intentTitle\}\}/g, intentTitle)
    .replace(/\{\{date\}\}/g, new Date().toISOString().substring(0, 10));
}
