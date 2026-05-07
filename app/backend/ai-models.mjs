import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const providers = {
  anthropic: (modelName) => anthropic(modelName),
  openai: (modelName) => openai(modelName),
};

export const getModel = (modelString) => {
  const [provider, modelName] = modelString.split(':');
  const factory = providers[provider];
  return factory ? factory(modelName) : anthropic(DEFAULT_MODEL);
};
