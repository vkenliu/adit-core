/**
 * API Reference template — endpoint documentation.
 */

export const DOC_API_REFERENCE_TEMPLATE = `# API Reference: {{title}}

## Endpoints
<!-- Document each API endpoint group. -->

### [Method] /api/path
- **Description**:
- **Auth required**: Yes/No
- **Request body**:
- **Response**:
- **Status codes**: 200, 400, 401, 404, 500

## Authentication
<!-- How API authentication works. Token types, header format. -->


## Error Codes
<!-- Standard error response format and error code table. -->

| Code | Meaning | When it occurs |
|------|---------|---------------|
| | | |

## Rate Limiting
<!-- Rate limiting policy, headers, and quotas. -->


## Pagination
<!-- How paginated endpoints work. Query params, response format. -->


## Versioning
<!-- API versioning strategy. Current version, deprecation policy. -->


## Webhooks
<!-- Outgoing webhook events, payload format, retry policy. -->


---
*Created: {{date}}*
*Document type: api-reference*
`;

export function renderApiReferenceTemplate(title: string): string {
  return DOC_API_REFERENCE_TEMPLATE.replace(/\{\{title\}\}/g, title).replace(
    /\{\{date\}\}/g,
    new Date().toISOString().substring(0, 10),
  );
}
