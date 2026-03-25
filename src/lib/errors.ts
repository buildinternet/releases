export class AdapterError extends Error {
  constructor(
    public adapter: string,
    message: string,
    public cause?: Error,
  ) {
    super(`[${adapter}] ${message}`);
    this.name = "AdapterError";
  }
}

export class AIError extends Error {
  constructor(
    message: string,
    public cause?: Error,
  ) {
    super(message);
    this.name = "AIError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
