// Reemplaza el contenido que hay entre dos comentarios HTML del README.
// Lo usan los dos scripts (perfil vivo y Akineitor), por eso vive aparte.
//
//   <!-- VIVO:INICIO -->
//   ...esto se sustituye...
//   <!-- VIVO:FIN -->

export function replaceBetweenMarkers(readmeText, markerName, newContent) {
  const startMarker = `<!-- ${markerName}:INICIO -->`;
  const endMarker = `<!-- ${markerName}:FIN -->`;

  const startIndex = readmeText.indexOf(startMarker);
  const endIndex = readmeText.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`No encuentro los marcadores ${startMarker} / ${endMarker} en el README`);
  }
  if (endIndex < startIndex) {
    throw new Error(`El marcador ${endMarker} aparece antes que ${startMarker}`);
  }

  const textBefore = readmeText.slice(0, startIndex + startMarker.length);
  const textAfter = readmeText.slice(endIndex);

  return `${textBefore}\n${newContent.trim()}\n${textAfter}`;
}
