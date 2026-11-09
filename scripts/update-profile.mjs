// Actualiza las partes "vivas" del perfil:
//   1. assets/generated/stats-card.svg  -> ficha de stats con nivel, racha y lenguajes
//   2. README.md entre <!-- VIVO:INICIO --> y <!-- VIVO:FIN -->  -> última partida guardada
//
// Uso en GitHub Actions:  GITHUB_TOKEN=... node scripts/update-profile.mjs
// Uso en local con datos inventados:  PERFIL_DATOS_DE_PRUEBA=ruta.json node scripts/update-profile.mjs

import { readFile, writeFile } from "node:fs/promises";
import { replaceBetweenMarkers } from "./readme-markers.mjs";

const GITHUB_USER = "whiterDJ-adri";
const PROFILE_REPO_NAME = "whiterDJ-adri"; // el repo del README no cuenta como "partida"

const README_PATH = new URL("../README.md", import.meta.url);
const STATS_CARD_PATH = new URL("../assets/generated/stats-card.svg", import.meta.url);
const DISPLAY_FONT_PATH = new URL("../assets/fonts/dela-gothic-one-latin-400-normal.woff2", import.meta.url);
const PIXEL_FONT_PATH = new URL("../assets/fonts/dotgothic16-latin-400-normal.woff2", import.meta.url);

const PALETTE = {
  ink: "#202125",
  inkLight: "#2C2D33",
  oniYellow: "#FFE707",
  oniPink: "#FF2D87",
  bone: "#F1E6D0",
  boneDim: "#A39C8E",
  gold: "#C9A24A",
};

const LANGUAGE_BAR_COLORS = [PALETTE.oniYellow, PALETTE.oniPink, PALETTE.bone, PALETTE.gold];
const LANGUAGES_TO_SHOW = 4;
const XP_BAR_BLOCK_COUNT = 20;

// ---------------------------------------------------------------------------
// 1. Obtener datos
// ---------------------------------------------------------------------------

async function callGithubRest(path) {
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "perfil-vivo",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub REST ${path} respondió ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function callGithubGraphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "perfil-vivo",
    },
    body: JSON.stringify({ query, variables }),
  });
  const responseBody = await response.json();
  if (!response.ok || responseBody.errors) {
    throw new Error(`GitHub GraphQL falló: ${JSON.stringify(responseBody.errors ?? responseBody)}`);
  }
  return responseBody.data;
}

async function fetchContributionDays() {
  const query = `
    query ($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`;
  const data = await callGithubGraphql(query, { login: GITHUB_USER });
  const weeks = data.user.contributionsCollection.contributionCalendar.weeks;

  const contributionDays = [];
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      contributionDays.push({ date: day.date, count: day.contributionCount });
    }
  }
  return contributionDays;
}

async function fetchOwnRepos() {
  const rawRepos = await callGithubRest(`users/${GITHUB_USER}/repos?per_page=100&type=owner&sort=pushed`);
  return rawRepos.map((rawRepo) => ({
    name: rawRepo.name,
    url: rawRepo.html_url,
    isFork: rawRepo.fork,
    pushedAt: rawRepo.pushed_at,
  }));
}

async function fetchLanguageBytesByRepo(repos) {
  const languageBytesByRepo = {};
  for (const repo of repos) {
    languageBytesByRepo[repo.name] = await callGithubRest(`repos/${GITHUB_USER}/${repo.name}/languages`);
  }
  return languageBytesByRepo;
}

async function fetchLatestCommit(repo) {
  const commits = await callGithubRest(`repos/${GITHUB_USER}/${repo.name}/commits?per_page=1`);
  if (commits.length === 0) {
    return null;
  }
  const latestCommit = commits[0];
  return {
    repoName: repo.name,
    repoUrl: repo.url,
    message: latestCommit.commit.message,
    date: latestCommit.commit.author.date,
    url: latestCommit.html_url,
  };
}

async function loadProfileData() {
  const testDataPath = process.env.PERFIL_DATOS_DE_PRUEBA;
  if (testDataPath) {
    return JSON.parse(await readFile(testDataPath, "utf8"));
  }
  if (!process.env.GITHUB_TOKEN) {
    throw new Error("Falta GITHUB_TOKEN (o PERFIL_DATOS_DE_PRUEBA para probar en local)");
  }

  const contributionDays = await fetchContributionDays();
  const allOwnRepos = await fetchOwnRepos();
  const gameRepos = allOwnRepos.filter(
    (repo) => !repo.isFork && repo.name.toLowerCase() !== PROFILE_REPO_NAME.toLowerCase(),
  );
  const languageBytesByRepo = await fetchLanguageBytesByRepo(gameRepos);

  const mostRecentlyPushedRepo = gameRepos[0] ?? null; // ya vienen ordenados por "pushed"
  const latestCommit = mostRecentlyPushedRepo ? await fetchLatestCommit(mostRecentlyPushedRepo) : null;

  return { contributionDays, gameRepos, languageBytesByRepo, latestCommit };
}

// ---------------------------------------------------------------------------
// 2. Calcular métricas
// ---------------------------------------------------------------------------

// Curva de nivel tipo RPG: para el nivel N hacen falta N² contribuciones.
// Así los primeros niveles llegan rápido y luego cuesta más subir.
function calculateLevel(totalContributions) {
  const currentLevel = Math.floor(Math.sqrt(totalContributions));
  const xpAtCurrentLevel = currentLevel * currentLevel;
  const xpAtNextLevel = (currentLevel + 1) * (currentLevel + 1);
  const xpIntoLevel = totalContributions - xpAtCurrentLevel;
  const xpNeededForLevel = xpAtNextLevel - xpAtCurrentLevel;

  return {
    currentLevel,
    xpIntoLevel,
    xpNeededForLevel,
    progressRatio: xpIntoLevel / xpNeededForLevel,
  };
}

function calculateStreaks(contributionDays) {
  // Racha actual: días seguidos con contribuciones contando hacia atrás desde hoy.
  // Si hoy aún no hay commits, la racha no se rompe: empezamos a contar desde ayer.
  let currentStreakDays = 0;
  let dayIndex = contributionDays.length - 1;
  const todayHasContributions = contributionDays[dayIndex]?.count > 0;
  if (!todayHasContributions) {
    dayIndex = dayIndex - 1;
  }
  while (dayIndex >= 0 && contributionDays[dayIndex].count > 0) {
    currentStreakDays = currentStreakDays + 1;
    dayIndex = dayIndex - 1;
  }

  let bestStreakDays = 0;
  let runningStreakDays = 0;
  for (const day of contributionDays) {
    if (day.count > 0) {
      runningStreakDays = runningStreakDays + 1;
      bestStreakDays = Math.max(bestStreakDays, runningStreakDays);
    } else {
      runningStreakDays = 0;
    }
  }

  return { currentStreakDays, bestStreakDays };
}

function calculateLastWeek(contributionDays) {
  const lastSevenDays = contributionDays.slice(-7);
  let contributionsThisWeek = 0;
  let activeDaysThisWeek = 0;
  for (const day of lastSevenDays) {
    contributionsThisWeek = contributionsThisWeek + day.count;
    if (day.count > 0) {
      activeDaysThisWeek = activeDaysThisWeek + 1;
    }
  }
  return { contributionsThisWeek, activeDaysThisWeek };
}

function calculateTopLanguages(languageBytesByRepo) {
  const totalBytesByLanguage = {};
  for (const languageBytes of Object.values(languageBytesByRepo)) {
    for (const [languageName, byteCount] of Object.entries(languageBytes)) {
      totalBytesByLanguage[languageName] = (totalBytesByLanguage[languageName] ?? 0) + byteCount;
    }
  }

  const allLanguagesSorted = Object.entries(totalBytesByLanguage).sort((a, b) => b[1] - a[1]);
  const totalBytes = allLanguagesSorted.reduce((sum, [, byteCount]) => sum + byteCount, 0);
  if (totalBytes === 0) {
    return [];
  }

  return allLanguagesSorted.slice(0, LANGUAGES_TO_SHOW).map(([languageName, byteCount]) => ({
    languageName,
    percentage: Math.round((byteCount / totalBytes) * 100),
  }));
}

function countReposTouchedInLastDays(gameRepos, numberOfDays, referenceDate) {
  const oldestAllowedTime = referenceDate.getTime() - numberOfDays * 24 * 60 * 60 * 1000;
  return gameRepos.filter((repo) => new Date(repo.pushedAt).getTime() >= oldestAllowedTime).length;
}

// ---------------------------------------------------------------------------
// 3. Dibujar la ficha de stats
// ---------------------------------------------------------------------------

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pluralizeDays(dayCount) {
  return dayCount === 1 ? "1 día" : `${dayCount} días`;
}

function buildXpBarBlocks(progressRatio, startX, startY) {
  const blockWidth = 14;
  const blockGap = 4;
  const blockHeight = 22;
  const filledBlockCount = Math.round(progressRatio * XP_BAR_BLOCK_COUNT);

  const blocks = [];
  for (let blockIndex = 0; blockIndex < XP_BAR_BLOCK_COUNT; blockIndex++) {
    const blockX = startX + blockIndex * (blockWidth + blockGap);
    const isFilled = blockIndex < filledBlockCount;
    if (isFilled) {
      // Cada bloque lleno aparece con un pequeño retraso: la barra "se carga" una vez al abrir el perfil.
      const appearDelaySeconds = (0.3 + blockIndex * 0.05).toFixed(2);
      blocks.push(
        `<rect class="xp-block" style="animation-delay:${appearDelaySeconds}s" x="${blockX}" y="${startY}" width="${blockWidth}" height="${blockHeight}" fill="${PALETTE.oniYellow}"/>`,
      );
    } else {
      blocks.push(
        `<rect x="${blockX}" y="${startY}" width="${blockWidth}" height="${blockHeight}" fill="${PALETTE.inkLight}"/>`,
      );
    }
  }
  return blocks.join("\n");
}

function buildLanguageRows(topLanguages, startX, startY) {
  const rowHeight = 44;
  const barStartOffset = 150;
  const maxBarWidth = 130;
  const rows = [];

  topLanguages.forEach((language, languageIndex) => {
    const rowY = startY + languageIndex * rowHeight;
    const barColor = LANGUAGE_BAR_COLORS[languageIndex % LANGUAGE_BAR_COLORS.length];
    const barWidth = Math.max(6, Math.round((language.percentage / 100) * maxBarWidth));
    const barX = startX + barStartOffset;
    rows.push(`
<text class="pixel label" x="${startX}" y="${rowY}">${escapeXml(language.languageName)}</text>
<rect x="${barX}" y="${rowY - 14}" width="${barWidth}" height="12" fill="${barColor}"/>
<text class="pixel small" x="${barX + barWidth + 10}" y="${rowY}">${language.percentage}%</text>`);
  });

  return rows.join("\n");
}

async function buildStatsCardSvg({ level, streaks, totalContributions, topLanguages }) {
  const displayFontBase64 = (await readFile(DISPLAY_FONT_PATH)).toString("base64");
  const pixelFontBase64 = (await readFile(PIXEL_FONT_PATH)).toString("base64");

  const cardWidth = 1200;
  const cardHeight = 300;
  const columnTwoX = 540;
  const columnThreeX = 850;

  const descriptionText =
    `Nivel ${level.currentLevel}, ${level.xpIntoLevel} de ${level.xpNeededForLevel} XP para el siguiente. ` +
    `Racha actual de ${pluralizeDays(streaks.currentStreakDays)}, mejor racha de ${pluralizeDays(streaks.bestStreakDays)}. ` +
    `Lenguajes más usados: ${topLanguages.map((l) => `${l.languageName} ${l.percentage}%`).join(", ")}.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cardWidth} ${cardHeight}" width="${cardWidth}" height="${cardHeight}" role="img" aria-labelledby="t d">
<title id="t">Ficha de stats</title>
<desc id="d">${escapeXml(descriptionText)}</desc>
<style>
@font-face { font-family: "Dela"; src: url(data:font/woff2;base64,${displayFontBase64}) format("woff2"); }
@font-face { font-family: "Dot"; src: url(data:font/woff2;base64,${pixelFontBase64}) format("woff2"); }
.display { font-family: "Dela", "Arial Black", sans-serif; fill: ${PALETTE.bone}; }
.pixel { font-family: "Dot", ui-monospace, monospace; fill: ${PALETTE.bone}; }
.label { font-size: 24px; }
.small { font-size: 20px; fill: ${PALETTE.boneDim}; }
.xp-block { animation: fill-in .25s steps(1, end) both; }
@keyframes fill-in { from { fill: ${PALETTE.inkLight}; } to { fill: ${PALETTE.oniYellow}; } }
@media (prefers-reduced-motion: reduce) { .xp-block { animation: none; } }
</style>
<clipPath id="card-shape"><rect width="${cardWidth}" height="${cardHeight}" rx="18"/></clipPath>
<g clip-path="url(#card-shape)">
<rect width="${cardWidth}" height="${cardHeight}" fill="${PALETTE.ink}"/>
<rect x="0" y="0" width="10" height="${cardHeight}" fill="${PALETTE.oniPink}"/>
</g>

<text class="pixel small" x="56" y="70">nivel</text>
<text class="display" x="56" y="140" font-size="72">${level.currentLevel}</text>
${buildXpBarBlocks(level.progressRatio, 56, 172)}
<text class="pixel small" x="56" y="234">${level.xpIntoLevel} / ${level.xpNeededForLevel} XP para el nivel ${level.currentLevel + 1}</text>
<text class="pixel small" x="56" y="264">${totalContributions} contribuciones en el último año</text>

<line x1="${columnTwoX - 40}" y1="50" x2="${columnTwoX - 40}" y2="250" stroke="${PALETTE.inkLight}" stroke-width="2"/>
<text class="pixel small" x="${columnTwoX}" y="70">racha actual</text>
<text class="display" x="${columnTwoX}" y="140" font-size="72">${streaks.currentStreakDays}</text>
<text class="pixel label" x="${columnTwoX}" y="176">${streaks.currentStreakDays === 1 ? "día" : "días"} seguidos</text>
<text class="pixel small" x="${columnTwoX}" y="234">mejor racha</text>
<text class="pixel label" x="${columnTwoX}" y="264">${pluralizeDays(streaks.bestStreakDays)}</text>

<line x1="${columnThreeX - 40}" y1="50" x2="${columnThreeX - 40}" y2="250" stroke="${PALETTE.inkLight}" stroke-width="2"/>
<text class="pixel small" x="${columnThreeX}" y="70">lenguajes más usados</text>
${buildLanguageRows(topLanguages, columnThreeX, 120)}
</svg>
`;
}

// ---------------------------------------------------------------------------
// 4. Escribir la sección "Última partida guardada"
// ---------------------------------------------------------------------------

function describeTimeAgo(isoDate, referenceDate) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const startOfReferenceDay = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
  );
  const commitDate = new Date(isoDate);
  const startOfCommitDay = Date.UTC(commitDate.getUTCFullYear(), commitDate.getUTCMonth(), commitDate.getUTCDate());
  const daysAgo = Math.round((startOfReferenceDay - startOfCommitDay) / millisecondsPerDay);

  if (daysAgo <= 0) return "hoy";
  if (daysAgo === 1) return "ayer";
  return `hace ${daysAgo} días`;
}

function escapeMarkdownInline(text) {
  return text.replace(/([\\`*_[\]<>|])/g, "\\$1");
}

function buildLiveSectionMarkdown({ latestCommit, lastWeek, reposTouchedThisWeek, referenceDate }) {
  const lines = [];

  if (latestCommit) {
    const firstLineOfMessage = latestCommit.message.split("\n")[0].trim();
    const timeAgo = describeTimeAgo(latestCommit.date, referenceDate);
    lines.push(`**[${latestCommit.repoName}](${latestCommit.repoUrl})**, ${timeAgo}:`);
    lines.push("");
    lines.push(`> [${escapeMarkdownInline(firstLineOfMessage)}](${latestCommit.url})`);
    lines.push("");
  } else {
    lines.push("Todavía no hay ninguna partida guardada.");
    lines.push("");
  }

  const reposWord = reposTouchedThisWeek === 1 ? "repositorio" : "repositorios";
  const contributionsWord = lastWeek.contributionsThisWeek === 1 ? "contribución" : "contribuciones";
  lines.push(
    `Esta semana: ${lastWeek.contributionsThisWeek} ${contributionsWord} en ${pluralizeDays(lastWeek.activeDaysThisWeek)}, ` +
      `repartidas en ${reposTouchedThisWeek} ${reposWord}.`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Programa principal
// ---------------------------------------------------------------------------

async function main() {
  const profileData = await loadProfileData();
  const referenceDate = profileData.referenceDate ? new Date(profileData.referenceDate) : new Date();

  let totalContributions = 0;
  for (const day of profileData.contributionDays) {
    totalContributions = totalContributions + day.count;
  }

  const level = calculateLevel(totalContributions);
  const streaks = calculateStreaks(profileData.contributionDays);
  const lastWeek = calculateLastWeek(profileData.contributionDays);
  const topLanguages = calculateTopLanguages(profileData.languageBytesByRepo);
  const reposTouchedThisWeek = countReposTouchedInLastDays(profileData.gameRepos, 7, referenceDate);

  const statsCardSvg = await buildStatsCardSvg({ level, streaks, totalContributions, topLanguages });
  await writeFile(STATS_CARD_PATH, statsCardSvg);

  const currentReadme = await readFile(README_PATH, "utf8");
  const liveSectionMarkdown = buildLiveSectionMarkdown({
    latestCommit: profileData.latestCommit,
    lastWeek,
    reposTouchedThisWeek,
    referenceDate,
  });
  const updatedReadme = replaceBetweenMarkers(currentReadme, "VIVO", liveSectionMarkdown);
  await writeFile(README_PATH, updatedReadme);

  console.log(`Nivel ${level.currentLevel} · racha ${streaks.currentStreakDays} · ${topLanguages.length} lenguajes`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
