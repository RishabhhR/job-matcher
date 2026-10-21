// Conservative CV hints for onboarding. Only the header is used for a current title,
// and skills are considered only inside an explicitly labeled skills section.
// Company and career dates are deliberately not guessed from arbitrary CV prose.
const TITLE_CANDIDATES = [
  ["Associate Product Manager", /\bassociate product manager\b|\bapm\b/i],
  ["Senior Product Manager", /\b(?:senior|sr\.?) product manager\b/i],
  ["Technical Product Manager", /\btechnical product manager\b/i],
  ["Product Manager", /\bproduct manager\b/i],
  ["Senior Software Engineer", /\b(?:senior|sr\.?) software engineer\b/i],
  ["Software Engineer", /\bsoftware engineer\b/i],
  ["Product Designer", /\bproduct designer\b/i],
  ["UX Designer", /\bux designer\b/i],
  ["Data Scientist", /\bdata scientist\b/i],
  ["Data Analyst", /\bdata analyst\b/i],
];

const SKILL_CANDIDATES = [
  "growth", "experimentation", "sql", "python", "pricing", "analytics", "fintech",
  "quick commerce", "consumer", "logistics", "ai", "b2b", "figma", "user research",
  "wireframing", "prototyping", "design systems", "react", "node.js", "typescript",
  "javascript", "golang", "java", "kubernetes", "aws", "docker",
];

export function inferCvProfile(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const header = lines.slice(0, 12).join("\n");
  const currentTitle = TITLE_CANDIDATES.find(([, pattern]) => pattern.test(header))?.[0] || "";

  const skillsHeading = /^(?:(?:technical )?skills|core competencies|key skills|technologies(?: and tools)?)\s*:?\s*(.*)$/i;
  const nextSection = /^(?:experience|employment|education|projects|certifications|summary|objective|achievements|languages|interests)\b/i;
  const skillLines = [];
  let inSkills = false;
  for (const line of lines) {
    const heading = line.match(skillsHeading);
    if (heading) {
      inSkills = true;
      if (heading[1]) skillLines.push(heading[1]);
      continue;
    }
    if (inSkills && nextSection.test(line)) break;
    if (inSkills) skillLines.push(line);
  }
  const skillText = skillLines.join(" ").toLowerCase();
  const skills = SKILL_CANDIDATES.filter((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(skillText);
  }).slice(0, 8);

  return { currentTitle, targetDesignation: currentTitle, skills };
}
