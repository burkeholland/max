import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

/** Project-local skills directory (max/skills/) */
const LOCAL_SKILLS_DIR = resolve(import.meta.dirname, "../../skills");

/** Global shared skills directory */
const GLOBAL_SKILLS_DIR = join(homedir(), ".agents", "skills");

/** Returns all skill directories that exist on disk. */
export function getSkillDirectories(): string[] {
  const dirs: string[] = [];
  if (existsSync(LOCAL_SKILLS_DIR)) dirs.push(LOCAL_SKILLS_DIR);
  if (existsSync(GLOBAL_SKILLS_DIR)) dirs.push(GLOBAL_SKILLS_DIR);
  return dirs;
}

export interface SkillInfo {
  slug: string;
  name: string;
  description: string;
  directory: string;
  source: "local" | "global";
}

/** Scan all skill directories and return metadata for each skill found. */
export function listSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  for (const [dir, source] of [
    [LOCAL_SKILLS_DIR, "local"] as const,
    [GLOBAL_SKILLS_DIR, "global"] as const,
  ]) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillDir = join(dir, entry);
      const skillMd = join(skillDir, "SKILL.md");
      if (!existsSync(skillMd)) continue;

      try {
        const content = readFileSync(skillMd, "utf-8");
        const { name, description } = parseFrontmatter(content);
        skills.push({
          slug: entry,
          name: name || entry,
          description: description || "(no description)",
          directory: skillDir,
          source,
        });
      } catch {
        skills.push({
          slug: entry,
          name: entry,
          description: "(could not read SKILL.md)",
          directory: skillDir,
          source,
        });
      }
    }
  }

  return skills;
}

/** Create a new skill in the local skills directory. */
export function createSkill(slug: string, name: string, description: string, instructions: string): string {
  const skillDir = join(LOCAL_SKILLS_DIR, slug);
  // Guard against path traversal
  if (!skillDir.startsWith(LOCAL_SKILLS_DIR + "/")) {
    return `Invalid slug '${slug}': must be a simple kebab-case name without path separators.`;
  }
  if (existsSync(skillDir)) {
    return `Skill '${slug}' already exists at ${skillDir}. Edit it directly or delete it first.`;
  }

  mkdirSync(skillDir, { recursive: true });

  writeFileSync(
    join(skillDir, "_meta.json"),
    JSON.stringify({ slug, version: "1.0.0" }, null, 2) + "\n"
  );

  const skillMd = `---
name: ${name}
description: ${description}
---

${instructions}
`;
  writeFileSync(join(skillDir, "SKILL.md"), skillMd);

  return `Skill '${name}' created at ${skillDir}. It will be available after restarting the daemon.`;
}

/** Parse YAML frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };

  const frontmatter = match[1];
  let name = "";
  let description = "";

  for (const line of frontmatter.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key === "name") name = value;
    if (key === "description") description = value;
  }

  return { name, description };
}
