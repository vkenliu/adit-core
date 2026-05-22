/**
 * Conventions template — coding standards and file organization.
 */

export const DOC_CONVENTIONS_TEMPLATE = `# Conventions: {{title}}

## Style Guide
<!-- Language-specific style rules. Linter/formatter config. -->

### General
<!-- Rules that apply across all files. -->

### TypeScript / JavaScript
<!-- TS-specific rules: strict mode, import style, etc. -->

## Naming
<!-- Naming conventions for variables, functions, classes, files. -->

| Element | Convention | Example |
|---------|-----------|---------|
| Variables | camelCase | userName |
| Constants | UPPER_SNAKE | MAX_SIZE |
| Functions | camelCase | getUser() |
| Classes | PascalCase | UserService |
| Files | kebab-case | user-service.ts |

## File Organization
<!-- Directory structure and file placement rules. -->

\`\`\`
src/
├── components/   <!-- UI components -->
├── lib/          <!-- Shared utilities -->
├── pages/        <!-- Route handlers -->
└── types/        <!-- Type definitions -->
\`\`\`

## Testing
<!-- Testing patterns: framework, file naming, what to test. -->


## Git Workflow
<!-- Branch naming, commit message format, PR process. -->


## Error Handling
<!-- How errors are handled, logged, and surfaced. -->


## Logging
<!-- Logging levels, format, and where logs go. -->


---
*Created: {{date}}*
*Document type: conventions*
`;

export function renderConventionsTemplate(title: string): string {
  return DOC_CONVENTIONS_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
