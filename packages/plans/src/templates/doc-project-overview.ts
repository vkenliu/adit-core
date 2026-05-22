/**
 * Project Overview template — README-level project description.
 */

export const DOC_PROJECT_OVERVIEW_TEMPLATE = `# {{title}} — Project Overview

## Purpose
<!-- What does this project do? Who is it for? One or two paragraphs. -->


## Architecture
<!-- High-level system design. Main modules, how they interact. -->


## Tech Stack
<!-- Languages, frameworks, databases, infrastructure. -->

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | | |
| Backend | | |
| Database | | |
| Infra | | |

## Getting Started
<!-- How to set up and run the project locally. -->

### Prerequisites

### Installation

### Running

## Deployment
<!-- How this project is deployed. Environments, CI/CD. -->


## Contributing
<!-- How to contribute. Branch naming, PR process, code review. -->


---
*Created: {{date}}*
*Document type: project-overview*
`;

export function renderProjectOverviewTemplate(title: string): string {
  return DOC_PROJECT_OVERVIEW_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
