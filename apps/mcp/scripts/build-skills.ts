/** Writes `src/skill-bundles.ts` from the skill sources listed in `skill-sources.ts`. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSkillFiles, renderSkillBundle } from "./skill-sources.js";

const OUT_FILE = resolve(import.meta.dir, "..", "src", "skill-bundles.ts");
const files = collectSkillFiles();
writeFileSync(OUT_FILE, renderSkillBundle(files));
console.log(`Wrote ${Object.keys(files).length} skill files to ${OUT_FILE}`);
