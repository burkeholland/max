import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir as osTmpdir } from "os";

const { _tmp } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs");
  const { join } = require("path");
  const { tmpdir } = require("os");
  return { _tmp: mkdtempSync(join(tmpdir(), "max-skills-test-")) };
});

vi.mock("../paths.js", () => {
  const { join } = require("path");
  return { SKILLS_DIR: join(_tmp, "local"), ensureMaxHome: () => {} };
});

vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return { ...original, homedir: () => _tmp };
});

vi.mock("url", async (importOriginal) => {
  const original = await importOriginal<typeof import("url")>();
  const { join } = require("path");
  return { ...original, fileURLToPath: () => join(_tmp, "bundled", "fake", "skills.js") };
});

import { listSkills, createSkill } from "./skills.js";

const bundledDir = join(_tmp, "bundled");
const localDir = join(_tmp, "local");
const globalDir = join(_tmp, "global");

beforeEach(() => {
  for (const dir of [bundledDir, localDir, globalDir]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(bundledDir, "fake"), { recursive: true });
});

afterEach(() => {
  for (const dir of [bundledDir, localDir, globalDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSkill(baseDir: string, slug: string, name: string, description: string, body = "") {
  const skillDir = join(baseDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
  );
}

describe("listSkills", () => {
  it("returns empty array when no skills exist", () => {
    expect(listSkills()).toEqual([]);
  });

  it("finds skills in the local directory", () => {
    writeSkill(localDir, "my-skill", "My Skill", "Does things");
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe("my-skill");
    expect(skills[0].name).toBe("My Skill");
    expect(skills[0].description).toBe("Does things");
    expect(skills[0].source).toBe("local");
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(localDir, "not-a-skill"), { recursive: true });
    writeFileSync(join(localDir, "not-a-skill", "README.md"), "hello");
    expect(listSkills()).toEqual([]);
  });

  it("handles skills with missing frontmatter gracefully", () => {
    const skillDir = join(localDir, "bad-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "No frontmatter here, just instructions.");
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("bad-skill"); // falls back to slug
  });
});

describe("createSkill", () => {
  it("creates a skill with SKILL.md and _meta.json", () => {
    const result = createSkill("test-skill", "Test Skill", "A test", "Do the thing");
    expect(result).toContain("created");
    expect(existsSync(join(localDir, "test-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(localDir, "test-skill", "_meta.json"))).toBe(true);
  });

  it("rejects duplicate skill names", () => {
    createSkill("dupe", "Dupe", "First", "instructions");
    const result = createSkill("dupe", "Dupe", "Second", "instructions");
    expect(result).toContain("already exists");
  });

  it("rejects path traversal attempts", () => {
    const result = createSkill("../escape", "Escape", "desc", "instructions");
    expect(result).toContain("Invalid slug");
  });

  it("new skill appears in listSkills", () => {
    createSkill("new-one", "New One", "brand new", "do stuff");
    const skills = listSkills();
    const found = skills.find((s) => s.slug === "new-one");
    expect(found).toBeDefined();
    expect(found!.name).toBe("New One");
    expect(found!.description).toBe("brand new");
  });
});
