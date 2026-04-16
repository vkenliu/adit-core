/**
 * Document type specification — defines structural expectations for
 * project documents used as AI pipeline context.
 *
 * Each doc type specifies required and recommended H2 sections.
 * Validation checks section presence and content density.
 */

/** Specification for a single document type */
export interface DocTypeSpec {
  id: string;
  label: string;
  description: string;
  requiredSections: string[];
  recommendedSections: string[];
  minContentLength: number;
}

/** Validation result for a single document */
export interface DocValidationResult {
  score: number; // 0–1
  detectedType: string;
  presentSections: string[];
  missingRequired: string[];
  missingRecommended: string[];
  stubSections: string[];
  suggestions: string[];
}

/** All supported document types */
export const DOC_TYPES: Record<string, DocTypeSpec> = {
  "project-overview": {
    id: "project-overview",
    label: "Project Overview",
    description: "README-level project description: purpose, architecture, tech stack",
    requiredSections: ["Purpose", "Architecture", "Tech Stack"],
    recommendedSections: ["Getting Started", "Deployment", "Contributing"],
    minContentLength: 50,
  },
  architecture: {
    id: "architecture",
    label: "Architecture",
    description: "System design, component relationships, and data flow",
    requiredSections: ["Components", "Data Flow", "Dependencies"],
    recommendedSections: ["Design Decisions", "Security", "Performance", "Scalability"],
    minContentLength: 80,
  },
  "api-reference": {
    id: "api-reference",
    label: "API Reference",
    description: "API endpoint documentation, authentication, and error codes",
    requiredSections: ["Endpoints", "Authentication", "Error Codes"],
    recommendedSections: ["Rate Limiting", "Pagination", "Versioning", "Webhooks"],
    minContentLength: 60,
  },
  "data-model": {
    id: "data-model",
    label: "Data Model",
    description: "Database schemas, fields, and entity relationships",
    requiredSections: ["Models", "Fields", "Relationships"],
    recommendedSections: ["Indexes", "Migrations", "Constraints", "Enums"],
    minContentLength: 60,
  },
  "business-context": {
    id: "business-context",
    label: "Business Context",
    description: "Business goals, user stories, and success criteria",
    requiredSections: ["Goals", "Users", "Success Criteria"],
    recommendedSections: ["User Stories", "Constraints", "Metrics", "Competitors"],
    minContentLength: 40,
  },
  conventions: {
    id: "conventions",
    label: "Conventions",
    description: "Coding standards, naming conventions, and file organization",
    requiredSections: ["Style Guide", "Naming", "File Organization"],
    recommendedSections: ["Testing", "Git Workflow", "Error Handling", "Logging"],
    minContentLength: 40,
  },
  general: {
    id: "general",
    label: "General",
    description: "General-purpose documentation with no required sections",
    requiredSections: [],
    recommendedSections: [],
    minContentLength: 30,
  },
};

/** Ordered list of doc type IDs for display */
export const DOC_TYPE_IDS = Object.keys(DOC_TYPES);

// ─── H2 Heading Extraction ────────────────────────────────────────

/** Extract H2 headings (## Title) from markdown content */
export function extractH2Headings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      headings.push(match[1].trim());
    }
  }
  return headings;
}

/** Extract section content between H2 headings */
export function extractSectionContents(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentHeading = "";
  let currentContent: string[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      if (currentHeading) {
        sections.set(currentHeading, currentContent.join("\n").trim());
      }
      currentHeading = match[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  // Don't forget the last section
  if (currentHeading) {
    sections.set(currentHeading, currentContent.join("\n").trim());
  }

  return sections;
}

// ─── Document Classification ──────────────────────────────────────

/**
 * Auto-detect document type by matching H2 headings against known section names.
 * Returns the best-matching type ID, or "general" if no match is confident.
 */
export function classifyDocument(content: string): string {
  const headings = extractH2Headings(content);
  if (headings.length === 0) return "general";

  const headingLower = headings.map((h) => h.toLowerCase());

  let bestType = "general";
  let bestScore = 0;

  for (const [typeId, spec] of Object.entries(DOC_TYPES)) {
    if (typeId === "general") continue;

    const allSections = [...spec.requiredSections, ...spec.recommendedSections];
    let matched = 0;
    for (const section of allSections) {
      if (headingLower.some((h) => h.includes(section.toLowerCase()))) {
        matched++;
      }
    }
    const score = allSections.length > 0 ? matched / allSections.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestType = typeId;
    }
  }

  // Need at least 30% match to classify; otherwise it's general
  return bestScore >= 0.3 ? bestType : "general";
}

// ─── Document Validation ──────────────────────────────────────────

/**
 * Validate a document's structural quality against its spec.
 * If docType is not provided, it will be auto-detected.
 */
export function validateDocument(
  content: string,
  docType?: string,
): DocValidationResult {
  const detectedType = docType || classifyDocument(content);
  const spec = DOC_TYPES[detectedType] || DOC_TYPES.general;

  const headings = extractH2Headings(content);
  const sectionContents = extractSectionContents(content);
  const headingLower = headings.map((h) => h.toLowerCase());

  // Check required sections
  const presentSections: string[] = [];
  const missingRequired: string[] = [];
  for (const section of spec.requiredSections) {
    const found = headingLower.some((h) => h.includes(section.toLowerCase()));
    if (found) {
      presentSections.push(section);
    } else {
      missingRequired.push(section);
    }
  }

  // Check recommended sections
  const missingRecommended: string[] = [];
  for (const section of spec.recommendedSections) {
    const found = headingLower.some((h) => h.includes(section.toLowerCase()));
    if (found) {
      presentSections.push(section);
    } else {
      missingRecommended.push(section);
    }
  }

  // Detect stub sections (placeholder-only content)
  const stubSections: string[] = [];
  for (const heading of headings) {
    const sectionContent = sectionContents.get(heading) || "";
    const strippedContent = sectionContent
      .replace(/<!--[\s\S]*?-->/g, "") // remove HTML comments
      .replace(/- \[ \]/g, "") // remove empty checkboxes
      .trim();

    if (strippedContent.length < spec.minContentLength) {
      stubSections.push(heading);
    }
  }

  // Compute score
  const totalRequired = spec.requiredSections.length;
  const totalRecommended = spec.recommendedSections.length;
  const totalPossible = totalRequired + totalRecommended;

  let score: number;
  if (totalPossible === 0) {
    // "general" type — score based on having any H2 sections with content
    const nonStubCount = headings.length - stubSections.length;
    score = headings.length > 0 ? Math.min(nonStubCount / Math.max(headings.length, 1), 1) : 0;
  } else {
    const requiredScore = totalRequired > 0 ? presentSections.filter((s) => spec.requiredSections.includes(s)).length / totalRequired : 1;
    const recommendedScore = totalRecommended > 0 ? presentSections.filter((s) => spec.recommendedSections.includes(s)).length / totalRecommended : 0;
    const stubRatio = headings.length > 0 ? stubSections.length / headings.length : 0;
    // Weight: structure (presence of headings) counts for 45%, content density for 55%
    const structureScore = requiredScore * 0.3 + recommendedScore * 0.15;
    const contentScore = (1 - stubRatio) * 0.55;
    score = Math.max(0, structureScore + contentScore);
    // If ALL sections are stubs, cap at 0.45 — an empty template is not useful
    if (stubSections.length === headings.length && headings.length > 0) {
      score = Math.min(score, 0.45);
    }
  }

  // Generate suggestions
  const suggestions: string[] = [];
  for (const section of missingRequired) {
    suggestions.push(`Add required section "## ${section}"`);
  }
  for (const section of missingRecommended) {
    suggestions.push(`Consider adding recommended section "## ${section}"`);
  }
  for (const section of stubSections) {
    suggestions.push(`Section "## ${section}" has little content — expand it`);
  }

  return {
    score,
    detectedType,
    presentSections,
    missingRequired,
    missingRecommended,
    stubSections,
    suggestions,
  };
}
