/**
 * Intent template — the "What & Why" document.
 *
 * Following SpecFlow methodology: define the vision before writing code.
 */

export const INTENT_TEMPLATE = `# Intent: {{title}}

## Vision
<!-- What are you building? One paragraph. -->


## Problem
<!-- What specific problem does this solve? Who experiences it? -->


## Success Criteria
<!-- How will you know this is done? Be specific and measurable. -->

- [ ]
- [ ]
- [ ]

## Constraints
<!-- What are the boundaries? Time, tech stack, compatibility, etc. -->


## Non-Goals
<!-- What are you explicitly NOT doing in this scope? -->


## Prior Art
<!-- What existing solutions have you looked at? What can you learn from them? -->


---
*Created: {{date}}*
*Status: draft*
`;

export function renderIntentTemplate(title: string): string {
  return INTENT_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
