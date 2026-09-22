const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "theta", "lambda"];
const FOLDERS = ["Inbox", "Projects", "Research", "Archive"];

/**
 * Builds a deterministic synthetic vault for index/search benchmarks.
 *
 * The `TFile` class is injected so the fixture stays free of Obsidian imports
 * and can be used both from tests and from scripts/bench-search.mjs.
 *
 * @param {any} TFileClass
 * @param {{ notes?: number, seed?: number }} [options]
 */
export function createSyntheticVault(TFileClass, { notes = 1000, seed = 42 } = {}) {
  const random = createRandom(seed);
  const files = new Map();
  const contents = new Map();
  const caches = new Map();
  const readCounts = new Map();
  const resolvedLinks = {};
  const unresolvedLinks = {};

  const pathFor = (index) => `Notes/${FOLDERS[index % FOLDERS.length]}/Note ${index}.md`;

  for (let index = 0; index < notes; index++) {
    const path = pathFor(index);
    const file = new TFileClass(path);
    files.set(path, file);

    const titleTopic = random() < 0.35 ? TOPICS[Math.floor(random() * TOPICS.length)] : "";
    const headingTopic = TOPICS[Math.floor(random() * TOPICS.length)];
    const bodyTopics = [TOPICS[Math.floor(random() * TOPICS.length)]];
    if (random() < 0.5) bodyTopics.push(TOPICS[Math.floor(random() * TOPICS.length)]);
    const tags = [`#tag${index % 20}`];
    if (titleTopic) tags.push(`#${titleTopic}`);

    contents.set(
      path,
      [
        "---",
        `tags: [${tags.join(", ")}]`,
        "---",
        `# ${headingTopic} overview ${index}`,
        "",
        `This note mentions ${bodyTopics.join(" and ")} in the body.`,
        `It links to [[Note ${(index * 7 + 3) % notes}]] and [[Note ${(index * 13 + 5) % notes}]].`,
        `Unresolved link to [[Missing ${index % 50}]].`,
        `Extra filler line ${index} for realistic file sizes.`
      ].join("\n")
    );

    caches.set(path, {
      frontmatter: { tags },
      tags: tags.map((tag) => ({ tag })),
      headings: [{ heading: `${headingTopic} overview ${index}` }, { heading: `Details ${index}` }]
    });

    const outgoing = {};
    for (const targetIndex of [(index * 7 + 3) % notes, (index * 13 + 5) % notes]) {
      const target = pathFor(targetIndex);
      if (target !== path) outgoing[target] = (outgoing[target] ?? 0) + 1;
    }
    if (Object.keys(outgoing).length > 0) resolvedLinks[path] = outgoing;
    unresolvedLinks[path] = { [`Missing ${index % 50}`]: 1 };
  }

  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path) => files.get(path),
      cachedRead: async (file) => {
        readCounts.set(file.path, (readCounts.get(file.path) ?? 0) + 1);
        return contents.get(file.path) ?? "";
      },
      adapter: { getBasePath: () => "/vault" }
    },
    metadataCache: {
      getFileCache: (file) => caches.get(file.path),
      resolvedLinks,
      unresolvedLinks,
      getFirstLinkpathDest: (linkpath) =>
        files.get(
          `Notes/${FOLDERS.find((folder) => files.has(`Notes/${folder}/${linkpath}.md`))}/${linkpath}.md`
        ) ?? files.get(`${linkpath}.md`)
    },
    workspace: { getActiveFile: () => files.get(pathFor(0)) }
  };

  return { app, files, contents, caches, readCounts, resolvedLinks, unresolvedLinks, pathFor };
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
