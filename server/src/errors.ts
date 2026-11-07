/** Fachlicher Fehler: wird mit Status 400 (oder statusCode) und Meldung an die Oberfläche gegeben. */
export class BusinessError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}
