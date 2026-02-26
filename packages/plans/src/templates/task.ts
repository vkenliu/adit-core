/**
 * Task template — atomic, completable units of work.
 */

export const TASK_TEMPLATE = `# Task: {{title}}

*Parent Roadmap: {{roadmapTitle}}*
*Phase: {{phase}}*

## Description
<!-- What exactly needs to be done? -->


## Acceptance Criteria
<!-- Specific conditions that must be met for this task to be "done" -->

- [ ]
- [ ]

## Implementation Notes
<!-- Technical approach, files to modify, APIs to use, etc. -->


## Session Log
<!-- Updated during execution — link ADIT event IDs here -->

| Session | Event ID | Action | Status |
|---------|----------|--------|--------|
|         |          |        |        |

---
*Created: {{date}}*
*Status: draft*
*Assigned: human | ai | pair*
`;

export function renderTaskTemplate(
  title: string,
  roadmapTitle: string,
  phase: string,
): string {
  return TASK_TEMPLATE.replace(/\{\{title\}\}/g, title)
    .replace(/\{\{roadmapTitle\}\}/g, roadmapTitle)
    .replace(/\{\{phase\}\}/g, phase)
    .replace(/\{\{date\}\}/g, new Date().toISOString().substring(0, 10));
}
