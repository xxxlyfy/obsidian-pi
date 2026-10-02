import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const outputPath = process.argv[2] ?? "release-notes.md";
const version = manifest.version;

const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headingPattern = new RegExp(
  `^##[ \t]+\\[?${escapedVersion}\\]?(?:[ \t]+-[ \t]+.*)?[ \t]*$`,
  "m"
);
const headingMatch = changelog.match(headingPattern);

if (!headingMatch || headingMatch.index === undefined) {
  console.error(`Could not find CHANGELOG.md section for version ${version}.`);
  process.exit(1);
}

const sectionStart = headingMatch.index;
const contentStart = sectionStart + headingMatch[0].length;
const sectionEnd = findNextHeading(changelog, contentStart);
const notes = changelog.slice(contentStart, sectionEnd).trim();

if (!notes) {
  console.error(`CHANGELOG.md section for version ${version} is empty.`);
  process.exit(1);
}

fs.writeFileSync(outputPath, notes.endsWith("\n") ? notes : `${notes}\n`, "utf8");
console.log(`Wrote ${outputPath} for version ${version}.`);

/**
 * The offset of the next `##` heading after `from`, or the end of the document.
 *
 * A line that starts with `##` inside a fenced code block is content, not a heading: a
 * release note that quotes a changelog snippet would otherwise end the section at that
 * line and publish a truncated body, which is worse than failing because it exits 0.
 *
 * @param {string} source
 * @param {number} from
 * @returns {number}
 */
function findNextHeading(source, from) {
  let offset = from;
  let fence = undefined;
  for (const line of source.slice(from).split("\n")) {
    const opener = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length)
        fence = undefined;
    } else if (opener) {
      fence = opener[1];
    } else if (/^##\s/.test(line)) {
      return offset;
    }
    offset += line.length + 1;
  }
  return source.length;
}
