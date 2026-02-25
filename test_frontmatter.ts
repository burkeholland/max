import { strict as assert } from 'assert';

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

// Test cases
const valid = `---
name: Test Skill
description: A description
---
Content`;

const noSpace = `---
name:Test Skill
description: A description
---
Content`;

const windowsLineEndings = `---\r\nname: Test Skill\r\ndescription: A description\r\n---`;

console.log('Valid:', parseFrontmatter(valid));
console.log('No Space:', parseFrontmatter(noSpace));
console.log('Windows EOL:', parseFrontmatter(windowsLineEndings));
