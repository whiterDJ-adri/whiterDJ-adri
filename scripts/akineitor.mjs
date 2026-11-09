// Akineitor de bolsillo: una partida compartida que se juega abriendo issues.
//
// Cómo funciona una jugada:
//   1. El README muestra la pregunta actual con enlaces Sí / No / No lo sé.
//   2. Cada enlace abre un issue con un título como   akineitor|p3-5|si
//      (partida 3, paso 5, respuesta "si").
//   3. El workflow .github/workflows/akineitor.yml ejecuta este script con ese título.
//   4. El script aplica la respuesta, elige la siguiente pregunta, guarda el estado
//      y vuelve a pintar la sección del README.
//
// Comandos:
//   node scripts/akineitor.mjs jugar       (lee AKINEITOR_TITULO y AKINEITOR_JUGADOR)
//   node scripts/akineitor.mjs reiniciar   (empieza una partida nueva desde cero)
//   node scripts/akineitor.mjs pintar      (solo vuelve a pintar el README con el estado actual)

import { readFile, writeFile } from "node:fs/promises";
import { replaceBetweenMarkers } from "./readme-markers.mjs";

const REPO_URL = "https://github.com/whiterDJ-adri/whiterDJ-adri";
const README_PATH = new URL("../README.md", import.meta.url);
const CHARACTERS_PATH = new URL("../game/akineitor-personajes.json", import.meta.url);
const STATE_PATH = new URL("../game/akineitor-estado.json", import.meta.url);

const VALID_ANSWERS = ["si", "no", "nose"];
const FINISHED_GAMES_TO_KEEP = 5;
const ISSUE_TITLE_PATTERN = /^akineitor\|(p\d+-\d+)\|(si|no|nose)$/;
const PLAYER_LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

function createNewGameState(gameNumber, allCharacterNames, finishedGames) {
  return {
    gameNumber,
    stepNumber: 1,
    remainingCharacterNames: [...allCharacterNames],
    askedQuestionIds: [],
    playersThisGame: [],
    currentStep: null, // se rellena con chooseNextStep()
    finishedGames,
  };
}

function buildTurnId(state) {
  return `p${state.gameNumber}-${state.stepNumber}`;
}

// ---------------------------------------------------------------------------
// Elegir la siguiente pregunta
// ---------------------------------------------------------------------------

// Un personaje encaja con una respuesta si su dato coincide o si el dato es dudoso (null).
function characterMatchesAnswer(character, questionId, answer) {
  const characterValue = character[questionId];
  if (characterValue === null) return true;
  if (answer === "si") return characterValue === true;
  if (answer === "no") return characterValue === false;
  return true;
}

// La mejor pregunta es la que deja menos candidatos en el peor caso:
// si respondes "sí" quedan A, si respondes "no" quedan B; queremos que el mayor de los dos sea lo más pequeño posible.
function findBestQuestion(remainingCharacters, unaskedQuestions) {
  let bestQuestion = null;
  let bestWorstCaseCount = Infinity;

  for (const question of unaskedQuestions) {
    const yesCount = remainingCharacters.filter((c) => characterMatchesAnswer(c, question.id, "si")).length;
    const noCount = remainingCharacters.filter((c) => characterMatchesAnswer(c, question.id, "no")).length;

    const questionCanEliminateSomeone = yesCount < remainingCharacters.length || noCount < remainingCharacters.length;
    if (!questionCanEliminateSomeone) {
      continue;
    }

    const worstCaseCount = Math.max(yesCount, noCount);
    if (worstCaseCount < bestWorstCaseCount) {
      bestQuestion = question;
      bestWorstCaseCount = worstCaseCount;
    }
  }

  return bestQuestion;
}

function chooseNextStep(state, gameData) {
  const remainingCharacters = gameData.characters.filter((c) => state.remainingCharacterNames.includes(c.name));
  const unaskedQuestions = gameData.questions.filter((q) => !state.askedQuestionIds.includes(q.id));

  if (remainingCharacters.length > 1) {
    const bestQuestion = findBestQuestion(remainingCharacters, unaskedQuestions);
    if (bestQuestion) {
      return { kind: "question", questionId: bestQuestion.id, text: bestQuestion.text };
    }
  }

  // Queda uno, o ninguna pregunta los distingue: toca adivinar.
  const guessedCharacterName = remainingCharacters[0].name;
  return { kind: "guess", characterName: guessedCharacterName, text: `¿Estás pensando en ${guessedCharacterName}?` };
}

// ---------------------------------------------------------------------------
// Aplicar una jugada
// ---------------------------------------------------------------------------

function addPlayer(state, playerLogin) {
  if (!state.playersThisGame.includes(playerLogin)) {
    state.playersThisGame.push(playerLogin);
  }
}

function finishGame(state, gameData, result, characterName) {
  const finishedGame = {
    gameNumber: state.gameNumber,
    result, // "acerte" | "perdi"
    characterName,
    stepCount: state.stepNumber,
    players: state.playersThisGame,
    finishedAt: new Date().toISOString(),
  };
  const finishedGames = [finishedGame, ...state.finishedGames].slice(0, FINISHED_GAMES_TO_KEEP);
  const allCharacterNames = gameData.characters.map((c) => c.name);

  const nextState = createNewGameState(state.gameNumber + 1, allCharacterNames, finishedGames);
  nextState.currentStep = chooseNextStep(nextState, gameData);
  return nextState;
}

// Devuelve { state, comment } con el estado nuevo y el texto para responder en el issue.
function applyMove(state, gameData, issueTitle, playerLogin) {
  const titleMatch = ISSUE_TITLE_PATTERN.exec(issueTitle.trim());
  if (!titleMatch) {
    return { state, comment: "No reconozco esta jugada. Usa los enlaces del perfil para responder." };
  }

  const [, turnIdFromIssue, answer] = titleMatch;
  if (turnIdFromIssue !== buildTurnId(state)) {
    return {
      state,
      comment:
        "Alguien respondió a esta pregunta antes que tú, así que la partida ya avanzó. " +
        `Mira la pregunta nueva en [el perfil](${REPO_URL}#akineitor-de-bolsillo).`,
    };
  }

  const currentStep = state.currentStep;

  if (currentStep.kind === "guess") {
    if (answer === "nose") {
      return { state, comment: "A esta solo puedo aceptar sí o no. Vuelve al perfil y elige una." };
    }

    addPlayer(state, playerLogin);

    if (answer === "si") {
      const nextState = finishGame(state, gameData, "acerte", currentStep.characterName);
      return {
        state: nextState,
        comment: `¡Lo sabía! Era ${currentStep.characterName}. Ya ha empezado la partida ${nextState.gameNumber}.`,
      };
    }

    // Ha fallado: descartamos a ese personaje y seguimos.
    state.remainingCharacterNames = state.remainingCharacterNames.filter((n) => n !== currentStep.characterName);
    if (state.remainingCharacterNames.length === 0) {
      const nextState = finishGame(state, gameData, "perdi", null);
      return {
        state: nextState,
        comment: `Me rindo: no se me ocurre nadie más. Habéis ganado. Ya ha empezado la partida ${nextState.gameNumber}.`,
      };
    }
  } else {
    addPlayer(state, playerLogin);
    state.askedQuestionIds.push(currentStep.questionId);

    const remainingCharacters = gameData.characters.filter((c) => state.remainingCharacterNames.includes(c.name));
    const charactersThatStillFit = remainingCharacters.filter((c) =>
      characterMatchesAnswer(c, currentStep.questionId, answer),
    );

    if (charactersThatStillFit.length === 0) {
      const nextState = finishGame(state, gameData, "perdi", null);
      return {
        state: nextState,
        comment: `No conozco a nadie así. Habéis ganado. Ya ha empezado la partida ${nextState.gameNumber}.`,
      };
    }
    state.remainingCharacterNames = charactersThatStillFit.map((c) => c.name);
  }

  state.stepNumber = state.stepNumber + 1;
  state.currentStep = chooseNextStep(state, gameData);

  const answerLabel = { si: "Sí", no: "No", nose: "No lo sé" }[answer];
  return {
    state,
    comment: `Anotado: ${answerLabel}. Siguiente pregunta: **${state.currentStep.text}** Puedes responderla en [el perfil](${REPO_URL}#akineitor-de-bolsillo).`,
  };
}

// ---------------------------------------------------------------------------
// Pintar la sección del README
// ---------------------------------------------------------------------------

function buildAnswerLink(state, answer, label) {
  const issueTitle = `akineitor|${buildTurnId(state)}|${answer}`;
  const issueBody =
    "Pulsa «Create» o «Submit new issue» para enviar tu respuesta. No hace falta escribir nada más.\n\n" +
    "En unos segundos el perfil mostrará la siguiente pregunta.";
  const url = `${REPO_URL}/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(issueBody)}`;
  return `[**${label}**](${url})`;
}

function buildPlayerLinks(playerLogins) {
  if (playerLogins.length === 0) return "nadie todavía";
  return playerLogins.map((login) => `[${login}](https://github.com/${login})`).join(", ");
}

function describeFinishedGame(finishedGame) {
  const stepsText = finishedGame.stepCount === 1 ? "1 paso" : `${finishedGame.stepCount} pasos`;
  if (finishedGame.result === "acerte") {
    return `Acerté: era ${finishedGame.characterName} (${stepsText})`;
  }
  return `Me ganasteis (${stepsText})`;
}

function buildGameSectionMarkdown(state, gameData) {
  const totalCharacterCount = gameData.characters.length;
  const remainingCount = state.remainingCharacterNames.length;
  const lines = [];

  lines.push(
    "Piensa en un personaje de Dragon Ball y responde a mis preguntas. " +
      "La partida es compartida: cualquiera que pase por aquí puede contestar la siguiente.",
  );
  lines.push("");
  lines.push(`**Partida ${state.gameNumber}, paso ${state.stepNumber}.** ${state.currentStep.text}`);
  lines.push("");

  const answerLinks = [buildAnswerLink(state, "si", "Sí"), buildAnswerLink(state, "no", "No")];
  if (state.currentStep.kind === "question") {
    answerLinks.push(buildAnswerLink(state, "nose", "No lo sé"));
  }
  lines.push(answerLinks.join(" · "));
  lines.push("");
  lines.push(
    `<sub>Cada respuesta abre un issue ya rellenado: solo tienes que enviarlo. ` +
      `Me quedan ${remainingCount} de ${totalCharacterCount} personajes posibles. ` +
      `En esta partida han jugado: ${buildPlayerLinks(state.playersThisGame)}.</sub>`,
  );
  lines.push("");

  if (state.finishedGames.length > 0) {
    lines.push("| Partida | Resultado | Jugadores |");
    lines.push("| --- | --- | --- |");
    for (const finishedGame of state.finishedGames) {
      lines.push(
        `| ${finishedGame.gameNumber} | ${describeFinishedGame(finishedGame)} | ${buildPlayerLinks(finishedGame.players)} |`,
      );
    }
    lines.push("");
  }

  const allNames = gameData.characters.map((c) => c.name).join(", ");
  lines.push("<details>");
  lines.push("<summary>¿En quién puedo pensar?</summary>");
  lines.push("");
  lines.push(`${allNames}.`);
  lines.push("");
  lines.push(
    "Es una versión de bolsillo de [Akineitor](https://akinator.innovux.es/): en cada paso elige la pregunta que más candidatos puede descartar.",
  );
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Programa principal
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function saveStateAndReadme(state, gameData) {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  const currentReadme = await readFile(README_PATH, "utf8");
  const updatedReadme = replaceBetweenMarkers(currentReadme, "JUEGO", buildGameSectionMarkdown(state, gameData));
  await writeFile(README_PATH, updatedReadme);
}

async function main() {
  const command = process.argv[2];
  const gameData = JSON.parse(await readFile(CHARACTERS_PATH, "utf8"));
  const allCharacterNames = gameData.characters.map((c) => c.name);

  if (command === "reiniciar") {
    const previousState = await loadState();
    const keptFinishedGames = previousState?.finishedGames ?? [];
    const nextGameNumber = (previousState?.gameNumber ?? 0) + 1;
    const freshState = createNewGameState(nextGameNumber, allCharacterNames, keptFinishedGames);
    freshState.currentStep = chooseNextStep(freshState, gameData);
    await saveStateAndReadme(freshState, gameData);
    console.log(`Partida ${freshState.gameNumber} lista: ${freshState.currentStep.text}`);
    return;
  }

  if (command === "pintar") {
    const state = await loadState();
    if (!state) throw new Error("No hay estado guardado. Ejecuta primero: node scripts/akineitor.mjs reiniciar");
    await saveStateAndReadme(state, gameData);
    return;
  }

  if (command === "jugar") {
    const issueTitle = process.env.AKINEITOR_TITULO ?? "";
    const playerLogin = process.env.AKINEITOR_JUGADOR ?? "";
    const commentOutputPath = process.env.AKINEITOR_COMENTARIO ?? "akineitor-comentario.md";

    if (!PLAYER_LOGIN_PATTERN.test(playerLogin)) {
      throw new Error(`Nombre de jugador no válido: ${JSON.stringify(playerLogin)}`);
    }

    const state = await loadState();
    if (!state) throw new Error("No hay estado guardado. Ejecuta primero: node scripts/akineitor.mjs reiniciar");

    const moveResult = applyMove(state, gameData, issueTitle, playerLogin);
    await saveStateAndReadme(moveResult.state, gameData);
    await writeFile(commentOutputPath, moveResult.comment);
    console.log(moveResult.comment);
    return;
  }

  throw new Error(`Comando desconocido: ${command}. Usa jugar, reiniciar o pintar.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
