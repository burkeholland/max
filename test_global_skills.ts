import { join } from 'path';
import { homedir } from 'os';

const GLOBAL_SKILLS_DIR = join(homedir(), ".agents", "skills");
console.log(`Global skills dir: ${GLOBAL_SKILLS_DIR}`);

// Is it safe to execute code/skills from a global directory controlled by the user?
// Yes, generally, if the user put them there. But if another process wrote there...
// This is likely intended behavior.
