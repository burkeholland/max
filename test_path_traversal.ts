import { join, resolve } from 'path';

const LOCAL_SKILLS_DIR = resolve('/home/burkeholland/dev/max/skills');
const maliciousSlug = '../../../../tmp/evil_skill';

const skillDir = join(LOCAL_SKILLS_DIR, maliciousSlug);
console.log(`Target path: ${skillDir}`);

if (skillDir.startsWith(LOCAL_SKILLS_DIR)) {
    console.log("Safe path");
} else {
    console.log("UNSAFE PATH DETECTED");
}
